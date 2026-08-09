package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.cache.Cache;

class RoundJwkCacheTest {

	@Test
	@DisplayName("ROUND JWK cache는 기록 후 60초가 되면 만료한다")
	void expiresJwkSetAtTheContractBoundary() {
		AtomicLong tickerNanos = new AtomicLong();
		Cache cache = RoundSecurityConfig.jwkSetCache(tickerNanos::get);
		String jwkSetUri = "https://baton.example/.well-known/round-jwks.json";
		String jwkSet = "{\"keys\":[]}";

		cache.put(jwkSetUri, jwkSet);
		tickerNanos.set(Duration.ofSeconds(59).toNanos());
		assertThat(cache.get(jwkSetUri, String.class)).isEqualTo(jwkSet);

		tickerNanos.set(Duration.ofSeconds(60).toNanos());
		assertThat(cache.get(jwkSetUri, String.class)).isNull();
	}
}
