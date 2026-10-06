package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import com.personal.round.auth.TestBatonIssuer;
import io.micrometer.core.instrument.MeterRegistry;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.Execution;
import org.junit.jupiter.api.parallel.ExecutionMode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

@SpringBootTest(
		webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {
			"server.address=127.0.0.1",
			"round.auth.mode=baton",
			"round.auth.cookie-name=__Secure-round_access",
			"round.auth.audience=round",
			"round.auth.max-grant-lifetime=5m",
			"round.signaling.allowed-origins=http://localhost:5173",
			"round.turn.provider=cloudflare",
			"round.turn.cloudflare-key-id=integration-key",
			"round.turn.cloudflare-api-token=integration-token"
		})
@Execution(ExecutionMode.SAME_THREAD)
class BatonJwkOutageIntegrationTest {

	private static final String COOKIE_NAME = "__Secure-round_access";
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final TestBatonIssuer BATON_ISSUER = TestBatonIssuer.start();
	private static final String PARTICIPATION_GRANT =
			BATON_ISSUER.issue(ROOM_ID, "ticket-jwk-outage");

	static {
		BATON_ISSUER.setJwkAvailable(false);
	}

	private final HttpClient httpClient = HttpClient.newHttpClient();

	@LocalServerPort
	private int port;

	@Autowired
	private MeterRegistry meterRegistry;

	@DynamicPropertySource
	static void batonIssuerProperties(DynamicPropertyRegistry registry) {
		registry.add("round.auth.issuer", BATON_ISSUER::issuer);
		registry.add("round.auth.jwk-set-uri", BATON_ISSUER::jwkSetUri);
	}

	@AfterAll
	static void stopBatonIssuer() {
		BATON_ISSUER.close();
	}

	@Test
	void keepsConsecutiveAuthenticationFailuresUnavailableAfterTheJwkRateLimit()
			throws Exception {
		assertThat(jwkSourceHealthy()).isEqualTo(1);
		HttpResponse<String> first = requestTurnCredentials();
		HttpResponse<String> second = requestTurnCredentials();
		HttpResponse<String> rateLimited = requestTurnCredentials();

		assertUnavailable(first);
		assertUnavailable(second);
		assertUnavailable(rateLimited);
		assertThat(BATON_ISSUER.jwkRequestCount()).isEqualTo(2);
		assertThat(jwkSourceHealthy()).isZero();
	}

	private double jwkSourceHealthy() {
		return meterRegistry.get("round.auth.jwk.source.healthy").gauge().value();
	}

	private HttpResponse<String> requestTurnCredentials() throws Exception {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(origin()
						+ "/api/rooms/"
						+ ROOM_ID
						+ "/turn-credentials"))
				.header(HttpHeaders.COOKIE, COOKIE_NAME + "=" + PARTICIPATION_GRANT)
				.header(HttpHeaders.ORIGIN, "http://localhost:5173")
				.header("Sec-Fetch-Site", "same-origin")
				.POST(HttpRequest.BodyPublishers.noBody())
				.build();
		return httpClient.send(request, HttpResponse.BodyHandlers.ofString());
	}

	private static void assertUnavailable(HttpResponse<String> response) {
		assertThat(response.statusCode()).isEqualTo(503);
		assertThat(response.headers().firstValue(HttpHeaders.CACHE_CONTROL))
				.hasValueSatisfying(value -> assertThat(value).contains("no-store"));
		assertThat(response.headers().firstValue(HttpHeaders.WWW_AUTHENTICATE))
				.isEmpty();
		assertThat(response.body()).isEmpty();
	}

	private String origin() {
		return "http://127.0.0.1:" + port;
	}
}
