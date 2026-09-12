package com.personal.round.turn;

import com.personal.round.config.TurnProperties;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class CoturnCredentials {
	private CoturnCredentials() {
	}

	static TurnCredentialMaterial issue(TurnProperties properties, long expiresAt) {
		String username = expiresAt + ":" + UUID.randomUUID();
		return new TurnCredentialMaterial(
				properties.coturnUrls(), username, sign(properties.coturnSecret(), username));
	}

	// coturn의 TURN REST 인증 규격은 Base64(HMAC-SHA1(secret, username))을 사용합니다.
	static String sign(String secret, String username) {
		try {
			Mac mac = Mac.getInstance("HmacSHA1");
			mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
			return Base64.getEncoder().encodeToString(mac.doFinal(username.getBytes(StandardCharsets.UTF_8)));
		}
		catch (GeneralSecurityException exception) {
			throw new IllegalStateException("TURN credential signing is unavailable", exception);
		}
	}
}
