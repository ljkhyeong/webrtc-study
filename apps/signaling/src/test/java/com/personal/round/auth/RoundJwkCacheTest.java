package com.personal.round.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.JWKSetBasedJWKSource;
import com.nimbusds.jose.jwk.source.JWKSetCacheRefreshEvaluator;
import com.nimbusds.jose.jwk.source.JWKSetSource;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.jwk.source.RateLimitReachedException;
import com.nimbusds.jose.proc.SecurityContext;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class RoundJwkCacheTest {

	@Test
	@DisplayName("ROUND JWK cache는 조회 후 60초 경계에서 갱신한다")
	void refreshesJwkSetAtTheCacheContractBoundary() throws Exception {
		CountingJwkSetSource remoteSource = new CountingJwkSetSource();
		JWKSetSource<SecurityContext> configuredSource = configuredSource(remoteSource);

		JWKSet initial = configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.noRefresh(),
				1_000L,
				null);
		assertThat(remoteSource.requestCount()).isOne();

		assertThat(configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.noRefresh(),
				60_999L,
				null))
				.isSameAs(initial);
		assertThat(remoteSource.requestCount()).isOne();

		configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.noRefresh(),
				61_000L,
				null);
		assertThat(remoteSource.requestCount()).isEqualTo(2);
	}

	@Test
	@DisplayName("초기 miss 재조회 뒤 30초 동안 추가 JWK refresh를 제한한다")
	void limitsAdditionalJwkRefreshesForThirtySeconds() throws Exception {
		CountingJwkSetSource remoteSource = new CountingJwkSetSource();
		JWKSetSource<SecurityContext> configuredSource = configuredSource(remoteSource);

		JWKSet cached = configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.noRefresh(),
				1_000L,
				null);
		configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.referenceComparison(cached),
				1_000L,
				null);
		assertThat(remoteSource.requestCount()).isEqualTo(2);

		assertThatThrownBy(() -> configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.referenceComparison(cached),
				30_999L,
				null))
				.isInstanceOf(RateLimitReachedException.class);
		assertThat(remoteSource.requestCount()).isEqualTo(2);

		configuredSource.getJWKSet(
				JWKSetCacheRefreshEvaluator.referenceComparison(cached),
				31_000L,
				null);
		assertThat(remoteSource.requestCount()).isEqualTo(3);
	}

	@SuppressWarnings("unchecked")
	private static JWKSetSource<SecurityContext> configuredSource(
			JWKSetSource<SecurityContext> remoteSource) {
		JWKSource<SecurityContext> jwkSource = RoundSecurityConfig.buildJwkSource(
				JWKSourceBuilder.create(remoteSource));
		assertThat(jwkSource).isInstanceOf(JWKSetBasedJWKSource.class);
		return ((JWKSetBasedJWKSource<SecurityContext>) jwkSource)
				.getJWKSetSource();
	}

	private static final class CountingJwkSetSource
			implements JWKSetSource<SecurityContext> {

		private final AtomicInteger requestCount = new AtomicInteger();
		private final JWKSet jwkSet = new JWKSet();

		@Override
		public JWKSet getJWKSet(
				JWKSetCacheRefreshEvaluator refreshEvaluator,
				long currentTime,
				SecurityContext context)
				throws KeySourceException {
			requestCount.incrementAndGet();
			return jwkSet;
		}

		int requestCount() {
			return requestCount.get();
		}

		@Override
		public void close() {
			// No external resource is owned by this test source.
		}
	}
}
