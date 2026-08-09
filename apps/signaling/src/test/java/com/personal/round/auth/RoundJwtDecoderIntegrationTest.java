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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationProvider;

class RoundJwtDecoderIntegrationTest {

	private static final String ACCOUNT_ID = "4c1e30a9-6d44-4f05-8f31-0f8a0f490042";
	private static final String KEY_ID = "round-test-key";
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

	private HttpServer jwkServer;
	private KeyPair trustedKeyPair;
	private String issuer;
	private JwtDecoder decoder;
	private AtomicBoolean jwkUnavailable;
	private AtomicInteger jwkRequestCount;

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

		jwkUnavailable = new AtomicBoolean();
		jwkRequestCount = new AtomicInteger();
		jwkServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		jwkServer.createContext("/jwks", exchange -> {
			jwkRequestCount.incrementAndGet();
			if (jwkUnavailable.get()) {
				exchange.sendResponseHeaders(503, -1);
				exchange.close();
				return;
			}
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
		if (jwkServer != null) {
			jwkServer.stop(0);
		}
	}

	@Test
	void exposesAnUnavailableJwkEndpointAsAuthenticationInfrastructureFailure()
			throws Exception {
		jwkUnavailable.set(true);
		String serialized = token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
				}).serialize();
		JwtAuthenticationProvider provider = new JwtAuthenticationProvider(decoder);

		assertThatThrownBy(() -> provider.authenticate(
				new BearerTokenAuthenticationToken(serialized)))
				.isInstanceOf(AuthenticationServiceException.class)
				.hasMessageContaining("decode the Jwt");
	}

	@Test
	void decodesARealRs256ParticipationGrantFromTheConfiguredJwkSet() throws Exception {
		Jwt jwt = decoder.decode(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
				}).serialize());

		assertThat(jwt.getIssuer().toString()).isEqualTo(issuer);
		assertThat(jwt.getSubject()).isEqualTo(ACCOUNT_ID);
		assertThat(jwt.getAudience()).containsExactly("round");
		assertThat(jwt.getClaimAsString("room_id")).isEqualTo(ROOM_ID);
	}

	@Test
	void rejectsSubjectsThatAreNotCanonicalBatonAccountUuids() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims.subject("member-42")));
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> claims.subject("1-1-1-1-1")));
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

	@Test
	@DisplayName("JOSE header에 kid가 없으면 BATON 참여권을 거부한다")
	void rejectsAMissingKeyId() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				null,
				claims -> {
				}));
	}

	@Test
	@DisplayName("JOSE header의 kid가 공백이면 BATON 참여권을 거부한다")
	void rejectsABlankKeyId() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				" \t",
				claims -> {
				}));
	}

	@Test
	@DisplayName("JOSE header의 kid 형식이 잘못되면 BATON 참여권을 거부한다")
	void rejectsAMalformedKeyId() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				"../baton signing key",
				claims -> {
				}));
	}

	@Test
	@DisplayName("JWK Set에 없는 kid이면 BATON 참여권을 거부한다")
	void rejectsAnUnsupportedKeyId() throws Exception {
		assertInvalid(token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				"retired-baton-key",
				claims -> {
				}));
	}

	@Test
	@DisplayName("서로 다른 unknown kid 반복은 JWK 재조회를 증폭하지 않고 모두 거부한다")
	void rateLimitsRepeatedUnknownKeyIds() throws Exception {
		SignedJWT validToken = token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				claims -> {
				});
		SignedJWT firstUnknownToken = token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				"unknown-baton-key-1",
				claims -> {
				});
		SignedJWT secondUnknownToken = token(
				trustedKeyPair,
				JWSAlgorithm.RS256,
				"unknown-baton-key-2",
				claims -> {
				});

		decoder.decode(validToken.serialize());
		assertThat(jwkRequestCount).hasValue(1);

		assertInvalid(firstUnknownToken);
		assertThat(jwkRequestCount).hasValue(2);

		assertInvalid(secondUnknownToken);
		assertThat(jwkRequestCount).hasValue(2);
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
		return token(signingKey, algorithm, KEY_ID, customizer);
	}

	private SignedJWT token(
			KeyPair signingKey,
			JWSAlgorithm algorithm,
			String keyId,
			Consumer<JWTClaimsSet.Builder> customizer)
			throws Exception {
		JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
				.issuer(issuer)
				.subject(ACCOUNT_ID)
				.audience("round")
				.issueTime(Date.from(NOW.minusSeconds(10)))
				.expirationTime(Date.from(NOW.plusSeconds(240)))
				.jwtID(UUID.randomUUID().toString())
				.claim("study_id", "study-7")
				.claim("room_id", ROOM_ID)
				.claim("role", "participant");
		customizer.accept(claims);
		JWSHeader.Builder header = new JWSHeader.Builder(algorithm)
				.type(JOSEObjectType.JWT);
		if (keyId != null) {
			header.keyID(keyId);
		}
		SignedJWT token = new SignedJWT(
				header.build(),
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
