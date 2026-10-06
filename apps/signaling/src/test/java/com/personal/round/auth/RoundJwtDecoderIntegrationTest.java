package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationProvider;

class RoundJwtDecoderIntegrationTest {

	private static final String ACCOUNT_ID = TestBatonIssuer.ACCOUNT_ID;
	private static final String KEY_ID = TestBatonIssuer.KEY_ID;
	private static final String ROOM_ID = "abcd-efgh-jkmp";
	private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");

	private TestBatonIssuer batonIssuer;
	private RSAKey trustedKey;
	private String issuer;
	private JwtDecoder decoder;
	private SimpleMeterRegistry meterRegistry;

	@BeforeEach
	void setUp() throws Exception {
		batonIssuer = TestBatonIssuer.start();
		trustedKey = batonIssuer.signingKey();
		issuer = batonIssuer.issuer();
		meterRegistry = new SimpleMeterRegistry();
		RoundAuthProperties properties = new RoundAuthProperties(
				RoundAuthProperties.Mode.BATON,
				"__Secure-round_access",
				issuer,
				"round",
				batonIssuer.jwkSetUri(),
				null,
				Duration.ofMinutes(5));
		decoder = new RoundSecurityConfig().batonJwtDecoder(
				properties,
				Clock.fixed(NOW, ZoneOffset.UTC),
				meterRegistry);
	}

	@AfterEach
	void tearDown() {
		if (batonIssuer != null) {
			batonIssuer.close();
		}
		if (meterRegistry != null) {
			meterRegistry.close();
		}
	}

	@Test
	void exposesAnUnavailableJwkEndpointAsAuthenticationInfrastructureFailure()
			throws Exception {
		batonIssuer.setJwkAvailable(false);
		String serialized = token(
				trustedKey,
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
				trustedKey,
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
		// 서명·시간은 디코더가, 참여권 클레임 형식은 인증 변환기가 확인한다. 운영 설정과 같은 순서로 인증한다.
		JwtAuthenticationProvider provider = new JwtAuthenticationProvider(decoder);
		provider.setJwtAuthenticationConverter(new ParticipationGrantAuthenticationConverter());
		for (String subject : new String[] {"member-42", "1-1-1-1-1"}) {
			String serialized = token(
					trustedKey,
					JWSAlgorithm.RS256,
					claims -> claims.subject(subject)).serialize();

			assertThatThrownBy(() -> provider.authenticate(
					new BearerTokenAuthenticationToken(serialized)))
					.as(subject)
					.isInstanceOf(InvalidBearerTokenException.class);
		}
	}

	@Test
	void acceptsNotBeforeAtTheExactSharedClockBoundary() throws Exception {
		Jwt jwt = decoder.decode(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims.notBeforeTime(Date.from(NOW))).serialize());

		assertThat(jwt.getNotBefore()).isEqualTo(NOW);
	}

	@Test
	void rejectsAGrantThatExpiredOneSecondBeforeTheSharedClock() throws Exception {
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(120)))
						.expirationTime(Date.from(NOW.minusSeconds(1)))));
	}

	@Test
	void rejectsAGrantAtTheExactSharedClockExpiryBoundary() throws Exception {
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(120)))
						.expirationTime(Date.from(NOW))));
	}

	@Test
	void rejectsInvalidCryptographyAndEveryConfiguredGrantBoundary() throws Exception {
		RSAKey untrustedKey = TestBatonIssuer.generateSigningKey(KEY_ID);

		assertInvalid(token(
				untrustedKey,
				JWSAlgorithm.RS256,
				claims -> {
				}));
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.PS256,
				claims -> {
				}));
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims.issuer("https://other-issuer.example")));
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims.audience("another-service")));
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.minusSeconds(300)))
						.expirationTime(Date.from(NOW.minusSeconds(120)))));
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> claims
						.issueTime(Date.from(NOW.plusSeconds(120)))
						.expirationTime(Date.from(NOW.plusSeconds(240)))));
		assertInvalid(token(
				trustedKey,
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
				trustedKey,
				JWSAlgorithm.RS256,
				null,
				claims -> {
				}));
	}

	@Test
	@DisplayName("JOSE header의 kid가 공백이면 BATON 참여권을 거부한다")
	void rejectsABlankKeyId() throws Exception {
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				" \t",
				claims -> {
				}));
	}

	@Test
	@DisplayName("JOSE header의 kid 형식이 잘못되면 BATON 참여권을 거부한다")
	void rejectsAMalformedKeyId() throws Exception {
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				"../baton signing key",
				claims -> {
				}));
	}

	@Test
	@DisplayName("JWK Set에 없는 kid이면 BATON 참여권을 거부한다")
	void rejectsAnUnsupportedKeyId() throws Exception {
		assertInvalid(token(
				trustedKey,
				JWSAlgorithm.RS256,
				"retired-baton-key",
				claims -> {
				}));
	}

	@Test
	@DisplayName("서로 다른 unknown kid 반복은 JWK 재조회를 증폭하지 않고 모두 거부한다")
	void rateLimitsRepeatedUnknownKeyIds() throws Exception {
		SignedJWT validToken = token(
				trustedKey,
				JWSAlgorithm.RS256,
				claims -> {
				});
		SignedJWT firstUnknownToken = token(
				trustedKey,
				JWSAlgorithm.RS256,
				"unknown-baton-key-1",
				claims -> {
				});
		SignedJWT secondUnknownToken = token(
				trustedKey,
				JWSAlgorithm.RS256,
				"unknown-baton-key-2",
				claims -> {
				});

		decoder.decode(validToken.serialize());
		assertThat(batonIssuer.jwkRequestCount()).isEqualTo(1);

		assertInvalid(firstUnknownToken);
		assertThat(batonIssuer.jwkRequestCount()).isEqualTo(2);

		assertInvalid(secondUnknownToken);
		assertThat(batonIssuer.jwkRequestCount()).isEqualTo(2);
	}

	private void assertInvalid(SignedJWT token) {
		assertThatThrownBy(() -> decoder.decode(token.serialize()))
				.isInstanceOf(JwtException.class);
	}

	private SignedJWT token(
			RSAKey signingKey,
			JWSAlgorithm algorithm,
			Consumer<JWTClaimsSet.Builder> customizer) {
		return token(signingKey, algorithm, KEY_ID, customizer);
	}

	private SignedJWT token(
			RSAKey signingKey,
			JWSAlgorithm algorithm,
			String keyId,
			Consumer<JWTClaimsSet.Builder> customizer) {
		return batonIssuer.sign(signingKey, algorithm, keyId, claims -> {
			claims.issueTime(Date.from(NOW.minusSeconds(10)))
					.expirationTime(Date.from(NOW.plusSeconds(240)))
					.claim("room_id", ROOM_ID);
			customizer.accept(claims);
		});
	}
}
