package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;
import java.util.Collections;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;

class SensitiveHeaderRedactingServletServerHttpRequestTest {

	@Test
	void hidesSensitiveHeadersCookiesAndTheOriginalPrincipalFromBothRequestApis() {
		MockHttpServletRequest nativeRequest = new MockHttpServletRequest();
		nativeRequest.addHeader(
				HttpHeaders.COOKIE,
				"__Secure-round_access=raw-jwt; preference=compact");
		nativeRequest.addHeader(HttpHeaders.AUTHORIZATION, "Bearer raw-jwt");
		nativeRequest.addHeader(HttpHeaders.PROXY_AUTHORIZATION, "Basic proxy-secret");
		nativeRequest.addHeader(HttpHeaders.ORIGIN, "https://study.example.com");
		nativeRequest.addHeader(HttpHeaders.UPGRADE, "websocket");
		nativeRequest.addHeader(HttpHeaders.CONNECTION, "Upgrade");
		nativeRequest.addHeader("Sec-WebSocket-Key", "test-key");
		nativeRequest.setCookies(
				new Cookie("__Secure-round_access", "raw-jwt"),
				new Cookie("preference", "compact"));
		Principal originalPrincipal = () -> "raw-jwt-principal";
		nativeRequest.setUserPrincipal(originalPrincipal);
		Principal participantPrincipal = () -> "member-42";

		SensitiveHeaderRedactingServletServerHttpRequest request =
				new SensitiveHeaderRedactingServletServerHttpRequest(
						new ServletServerHttpRequest(nativeRequest),
						participantPrincipal);

		assertThat(request.getHeaders().containsHeader(HttpHeaders.COOKIE)).isFalse();
		assertThat(request.getHeaders().containsHeader(HttpHeaders.AUTHORIZATION)).isFalse();
		assertThat(request.getHeaders().containsHeader(HttpHeaders.PROXY_AUTHORIZATION))
				.isFalse();
		assertThat(request.getHeaders().getFirst(HttpHeaders.ORIGIN))
				.isEqualTo("https://study.example.com");

		HttpServletRequest sanitizedNativeRequest = request.getServletRequest();
		assertThat(Collections.list(sanitizedNativeRequest.getHeaderNames()))
				.doesNotContain(
						HttpHeaders.COOKIE,
						HttpHeaders.AUTHORIZATION,
						HttpHeaders.PROXY_AUTHORIZATION)
				.contains(
						HttpHeaders.ORIGIN,
						HttpHeaders.UPGRADE,
						HttpHeaders.CONNECTION,
						"Sec-WebSocket-Key");
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.COOKIE)).isNull();
		assertThat(Collections.list(
				sanitizedNativeRequest.getHeaders(HttpHeaders.AUTHORIZATION))).isEmpty();
		assertThat(sanitizedNativeRequest.getCookies()).isNull();
		assertThat(sanitizedNativeRequest.getHeader(HttpHeaders.UPGRADE))
				.isEqualTo("websocket");
		assertThat(sanitizedNativeRequest.getUserPrincipal())
				.isSameAs(participantPrincipal);
		assertThat(sanitizedNativeRequest.getRemoteUser()).isEqualTo("member-42");
	}
}
