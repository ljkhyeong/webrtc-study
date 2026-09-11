package com.personal.round.turn;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.EnumMap;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public final class TurnCredentialMetrics {

	private final Counter issued;
	private final Counter providerErrors;
	private final Map<TurnCredentialRateLimitScope, Counter> rateLimited;

	public TurnCredentialMetrics(MeterRegistry registry) {
		issued = Counter.builder("round.turn.credentials.issued")
				.description("발급에 성공한 TURN 자격 증명 수")
				.register(registry);
		providerErrors = Counter.builder("round.turn.credentials.provider.errors")
				.description("실패한 Cloudflare TURN 자격 증명 요청 수")
				.register(registry);
		rateLimited = new EnumMap<>(TurnCredentialRateLimitScope.class);
		for (TurnCredentialRateLimitScope scope
				: TurnCredentialRateLimitScope.values()) {
			rateLimited.put(
					scope,
					Counter.builder("round.turn.credentials.rate_limited")
							.tag("scope", scope.metricTag())
							.description("발급 한도로 거부한 TURN 자격 증명 요청 수")
							.register(registry));
		}
	}

	void recordIssued() {
		issued.increment();
	}

	void recordRateLimited(TurnCredentialRateLimitScope scope) {
		rateLimited.get(scope).increment();
	}

	void recordProviderError() {
		providerErrors.increment();
	}
}
