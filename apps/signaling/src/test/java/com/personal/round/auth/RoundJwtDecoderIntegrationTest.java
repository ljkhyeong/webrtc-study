package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

class RoundJwtDecoderIntegrationTest {

	private static final String KEY_ID = "round-test-key";
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

	private HttpServer jwkServer;
	private KeyPair trustedKeyPair;
	private String issuer;
	private JwtDecoder decoder;

	@BeforeEach
	void setUp() throws Exception {
		trustedKeyPair = rsaKeyPair();
		RSAKey publicJwk = new RSAKey.Builder(
				(RSAPublicKey) trustedKeyPair.getPublic())
				.keyID(KEY_ID)
				.algorithm(JWSAlgorithm.RS256)
				.build();
		byte[] jwkSet = new JWKSet(publicJwk)
				.toString()
				.getBytes(StandardCharsets.UTF_8);

		jwkServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		jwkServer.createContext("/jwks", exchange -> {
			exchange.getResponseHeaders().set("Content-Type", "application/json");
			exchange.sendResponseHeaders(200, jwkSet.length);
			try (var responseBody = exchange.getResponseBody()) {
				responseBody.write(jwkSet);
			}
		});
		jwkServer.start();

		String baseUrl = "http://127.0.0.1:" + jwkServer.getAddress().getPort();
		issuer = baseUrl + "/issuer";
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				issuer,
				"round",
				baseUrl + "/jwks",
				null,
				Duration.ofMinutes(5));
		decoder = new RoundSecurityConfig().batonJwtDecoder(
				properties,
				Clock.fixed(NOW, ZoneOffset.UTC));
	}

	@AfterEach
	void tearDown() {
		jwkServer.stop(0);
	}

	@Test
	void decodesARealRs256ParticipationGrantFromTheConfiguredJwkSet() throws Exception {
		Jwt jwt = decoder.decode(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
				}).serialize());

		assertThat(jwt.getIssuer().toString()).isEqualTo(issuer);
		assertThat(jwt.getAudience()).containsExactly("round");
		assertThat(jwt.getClaimAsString("room_id")).isEqualTo(ROOM_ID);
	}

	@Test
	void acceptsNotBeforeAtTheExactSharedClockBoundary() throws Exception {
		Jwt jwt = decoder.decode(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims.notBeforeTime(Date.from(NOW))).serialize());

		assertThat(jwt.getNotBefore()).isEqualTo(NOW);
	}

	@Test
	void rejectsAGrantThatExpiredOneSecondBeforeTheSharedClock() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(120)))
						.expirationTime(Date.from(NOW.minusSeconds(1)))));
	}

	@Test
	void rejectsAGrantAtTheExactSharedClockExpiryBoundary() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(120)))
						.expirationTime(Date.from(NOW))));
	}

	@Test
	void rejectsInvalidCryptographyAndEveryConfiguredGrantBoundary() throws Exception {
		KeyPair untrustedKeyPair = rsaKeyPair();

		assertInvalid(token(
				untrustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
				}));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.PS256,
				claims -> {
				}));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims.issuer("https://other-issuer.example")));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims.audience("another-service")));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(300)))
						.expirationTime(Date.from(NOW.minusSeconds(120)))));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.plusSeconds(120)))
						.expirationTime(Date.from(NOW.plusSeconds(240)))));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
					Instant issuedAt = NOW;
					claims.issueTime(Date.from(issuedAt))
							.expirationTime(Date.from(issuedAt.plusSeconds(301)));
				}));
	}

	private void assertInvalid(SignedJWT token) {
		assertThatThrownBy(() -> decoder.decode(token.serialize()))
				.isInstanceOf(JwtException.class);
	}

	private SignedJWT token(
			KeyPair signingKey,
			JWSAlgorithm algorithm,
			Consumer<JWTClaimsSet.Builder> customizer)
			throws Exception {
		JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
				.issuer(issuer)
				.subject("member-42")
				.audience("round")
				.issueTime(Date.from(NOW.minusSeconds(10)))
				.expirationTime(Date.from(NOW.plusSeconds(240)))
				.jwtID(UUID.randomUUID().toString())
				.claim("study_id", "study-7")
				.claim("room_id", ROOM_ID)
				.claim("role", "participant");
		customizer.accept(claims);
		SignedJWT token = new SignedJWT(
				new JWSHeader.Builder(algorithm)
						.type(JOSEObjectType.JWT)
						.keyID(KEY_ID)
						.build(),
				claims.build());
		token.sign(new RSASSASigner(signingKey.getPrivate()));
		return token;
	}

	private static KeyPair rsaKeyPair() throws Exception {
		KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
		generator.initialize(2_048);
		return generator.generateKeyPair();
	}
}
