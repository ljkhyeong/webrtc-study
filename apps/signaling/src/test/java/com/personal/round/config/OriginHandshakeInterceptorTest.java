package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.config.OriginPolicy.SecurityMode;
import java.util.HashMap;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;

class OriginHandshakeInterceptorTest {

	@Test
	void allowsOnlyConfiguredOriginValuesAfterOriginNormalization() {
		OriginHandshakeInterceptor interceptor = interceptor(
				List.of("http://localhost:5173", "https://study.example"));

		assertThat(handshake(interceptor, "http://localhost:5173/").allowed()).isTrue();
		assertThat(handshake(interceptor, "https://study.example:443").allowed()).isTrue();

		HandshakeResult missing = handshake(interceptor, null);
		assertThat(missing.allowed()).isFalse();
		verify(missing.response()).setStatusCode(HttpStatus.FORBIDDEN);

		assertThat(handshake(interceptor, "https://study.example/path").allowed()).isFalse();
		assertThat(handshake(interceptor, "https://evil.example").allowed()).isFalse();
	}

	@Test
	void wildcardExplicitlyAllowsMissingOrigin() {
		OriginHandshakeInterceptor interceptor = interceptor(List.of("*"));

		assertThat(handshake(interceptor, null).allowed()).isTrue();
		assertThat(handshake(interceptor, "not-even-an-origin").allowed()).isTrue();
	}

	@Test
	void nullOriginMustBeExplicitlyAllowedOutsideProduction() {
		OriginPolicy policy = new OriginPolicy(List.of("null"), SecurityMode.DEVELOPMENT);

		assertThat(policy.allows("null")).isTrue();
		assertThat(policy.allows(null)).isFalse();
		assertThat(policy.allows("https://study.example")).isFalse();
	}

	@Test
	void rejectsInvalidConfiguredOriginsAtStartup() {
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("https://study.example/path"),
				SecurityMode.DEVELOPMENT))
				.isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void productionProfileFailsFastForWildcardNullAndNonHttpsOrigins() {
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("*"),
				SecurityMode.STANDALONE_PRODUCTION))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("null"),
				SecurityMode.STANDALONE_PRODUCTION))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("null origin");
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("http://study.example"),
				SecurityMode.STANDALONE_PRODUCTION))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("HTTPS");

		assertThat(new OriginPolicy(
				List.of("https://study.example"),
				SecurityMode.STANDALONE_PRODUCTION)
				.allows("https://study.example")).isTrue();
	}

	@Test
	void batonModeRejectsUnsafeOriginsWithoutDependingOnTheProductionProfile() {
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("*"),
				SecurityMode.BATON_DEVELOPMENT))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("Wildcard");
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("null"),
				SecurityMode.BATON_DEVELOPMENT))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("null origin");
		assertThatThrownBy(() -> new OriginPolicy(
				List.of("http://baton.example"),
				SecurityMode.BATON_DEVELOPMENT))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("HTTPS or loopback HTTP");

		assertThat(new OriginPolicy(
				List.of("http://127.0.0.1:5173", "https://baton.example"),
				SecurityMode.BATON_DEVELOPMENT)
				.allows("http://127.0.0.1:5173"))
				.isTrue();
	}

	private OriginHandshakeInterceptor interceptor(List<String> origins) {
		return new OriginHandshakeInterceptor(
				new OriginPolicy(origins, SecurityMode.DEVELOPMENT));
	}

	private HandshakeResult handshake(
			OriginHandshakeInterceptor interceptor,
			String origin) {
		ServerHttpRequest request = mock(ServerHttpRequest.class);
		ServerHttpResponse response = mock(ServerHttpResponse.class);
		HttpHeaders headers = new HttpHeaders();
		if (origin != null) {
			headers.setOrigin(origin);
		}
		when(request.getHeaders()).thenReturn(headers);
		boolean allowed = interceptor.beforeHandshake(
				request,
				response,
				mock(WebSocketHandler.class),
				new HashMap<>());
		return new HandshakeResult(allowed, response);
	}

	private record HandshakeResult(boolean allowed, ServerHttpResponse response) {
	}
}
