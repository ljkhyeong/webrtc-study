package com.personal.round.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** BATON의 참여권 서명 키와 JWK Set 엔드포인트를 대신하는 테스트 발급자다. 테스트마다 새로 만들 수 있다. */
public final class TestBatonIssuer implements AutoCloseable {

	public static final String ACCOUNT_ID = "4c1e30a9-6d44-4f05-8f31-0f8a0f490042";
	public static final String KEY_ID = "baton-test-key";

	private final RSAKey signingKey = generateSigningKey(KEY_ID);
	private final AtomicBoolean jwkAvailable = new AtomicBoolean(true);
	private final AtomicInteger jwkRequestCount = new AtomicInteger();
	private final HttpServer server;
	private final String issuer;

	private TestBatonIssuer() throws IOException {
		byte[] jwkSet = new JWKSet(signingKey.toPublicJWK())
				.toString()
				.getBytes(StandardCharsets.UTF_8);
		server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		issuer = "http://127.0.0.1:" + server.getAddress().getPort() + "/oauth2";
		server.createContext("/oauth2/jwks", exchange -> {
			jwkRequestCount.incrementAndGet();
			if (!jwkAvailable.get()) {
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
		server.start();
	}

	public static TestBatonIssuer start() {
		try {
			return new TestBatonIssuer();
		}
		catch (IOException exception) {
			throw new UncheckedIOException(exception);
		}
	}

	public static RSAKey generateSigningKey(String keyId) {
		try {
			return new RSAKeyGenerator(2_048)
					.keyID(keyId)
					.algorithm(JWSAlgorithm.RS256)
					.generate();
		}
		catch (JOSEException exception) {
			throw new IllegalStateException(exception);
		}
	}

	public String issuer() {
		return issuer;
	}

	public String jwkSetUri() {
		return issuer + "/jwks";
	}

	public int jwkRequestCount() {
		return jwkRequestCount.get();
	}

	public void setJwkAvailable(boolean available) {
		jwkAvailable.set(available);
	}

	public RSAKey signingKey() {
		return signingKey;
	}

	/** 지금부터 4분 동안 유효한 참여권을 발급자의 키로 서명한다. */
	public String issue(String roomId, String tokenId) {
		return issue(roomId, tokenId, KEY_ID, claims -> {
		});
	}

	public String issue(
			String roomId,
			String tokenId,
			String keyId,
			Consumer<JWTClaimsSet.Builder> customizer) {
		Instant now = Instant.now();
		return sign(signingKey, JWSAlgorithm.RS256, keyId, claims -> {
			claims.issueTime(Date.from(now.minusSeconds(30)))
					.expirationTime(Date.from(now.plusSeconds(240)))
					.jwtID(tokenId)
					.claim("room_id", roomId);
			customizer.accept(claims);
		}).serialize();
	}

	/**
	 * 기본 참여권 클레임(iss·sub·aud·jti·study_id·role)에 호출자가 시간과 방을 더해 서명한다.
	 * keyId가 null이면 kid를 넣지 않는다.
	 */
	public SignedJWT sign(
			RSAKey key,
			JWSAlgorithm algorithm,
			String keyId,
			Consumer<JWTClaimsSet.Builder> customizer) {
		JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
				.issuer(issuer)
				.subject(ACCOUNT_ID)
				.audience("round")
				.jwtID(UUID.randomUUID().toString())
				.claim("study_id", "study-7")
				.claim("role", "participant");
		customizer.accept(claims);
		SignedJWT token = new SignedJWT(
				new JWSHeader.Builder(algorithm)
						.type(JOSEObjectType.JWT)
						.keyID(keyId)
						.build(),
				claims.build());
		try {
			token.sign(new RSASSASigner(key));
		}
		catch (JOSEException exception) {
			throw new IllegalStateException(exception);
		}
		return token;
	}

	@Override
	public void close() {
		server.stop(0);
	}
}
