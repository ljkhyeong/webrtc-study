package com.personal.round;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.MeterRegistry;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
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
	private static final UnavailableJwkIssuer BATON_ISSUER =
			UnavailableJwkIssuer.start();
	private static final String PARTICIPATION_GRANT =
			BATON_ISSUER.issueParticipationGrant();

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

	private static final class UnavailableJwkIssuer implements AutoCloseable {

		private static final String KEY_ID = "baton-outage-test-key";
		private static final String ACCOUNT_ID =
				"4c1e30a9-6d44-4f05-8f31-0f8a0f490042";

		private final HttpServer server;
		private final KeyPair signingKey;
		private final String issuer;
		private final AtomicInteger jwkRequestCount = new AtomicInteger();

		private UnavailableJwkIssuer(
				HttpServer server,
				KeyPair signingKey,
				String issuer) {
			this.server = server;
			this.signingKey = signingKey;
			this.issuer = issuer;
		}

		static UnavailableJwkIssuer start() {
			try {
				HttpServer server = HttpServer.create(
						new InetSocketAddress("127.0.0.1", 0),
						0);
				String issuer = "http://127.0.0.1:"
						+ server.getAddress().getPort()
						+ "/oauth2";
				UnavailableJwkIssuer testIssuer = new UnavailableJwkIssuer(
						server,
						rsaKeyPair(),
						issuer);
				server.createContext("/oauth2/jwks", exchange -> {
					testIssuer.jwkRequestCount.incrementAndGet();
					exchange.sendResponseHeaders(503, -1);
					exchange.close();
				});
				server.start();
				return testIssuer;
			}
			catch (Exception exception) {
				throw new IllegalStateException(
						"Could not start the unavailable BATON test issuer",
						exception);
			}
		}

		String issuer() {
			return issuer;
		}

		String jwkSetUri() {
			return issuer + "/jwks";
		}

		int jwkRequestCount() {
			return jwkRequestCount.get();
		}

		String issueParticipationGrant() {
			try {
				Instant now = Instant.now();
				JWTClaimsSet claims = new JWTClaimsSet.Builder()
						.issuer(issuer)
						.subject(ACCOUNT_ID)
						.audience(List.of("round"))
						.issueTime(Date.from(now.minusSeconds(30)))
						.expirationTime(Date.from(now.plusSeconds(240)))
						.jwtID("ticket-jwk-outage")
						.claim("study_id", "study-7")
						.claim("room_id", ROOM_ID)
						.claim("role", "participant")
						.build();
				SignedJWT token = new SignedJWT(
						new JWSHeader.Builder(JWSAlgorithm.RS256)
								.type(JOSEObjectType.JWT)
								.keyID(KEY_ID)
								.build(),
						claims);
				token.sign(new RSASSASigner(signingKey.getPrivate()));
				return token.serialize();
			}
			catch (Exception exception) {
				throw new IllegalStateException(
						"Could not sign a BATON participation grant",
						exception);
			}
		}

		private static KeyPair rsaKeyPair() throws Exception {
			KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
			generator.initialize(2_048);
			return generator.generateKeyPair();
		}

		@Override
		public void close() {
			server.stop(0);
		}
	}
}
