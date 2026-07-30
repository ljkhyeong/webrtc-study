package com.personal.round.turn;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.EnumMap;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public final class TurnCredentialMetrics {

	private final Counter issued;
	private final Map<TurnCredentialRateLimitScope, Counter> rateLimited;

	public TurnCredentialMetrics(MeterRegistry registry) {
		issued = Counter.builder("round.turn.credentials.issued")
				.description("TURN credentials successfully issued")
				.register(registry);
		rateLimited = new EnumMap<>(TurnCredentialRateLimitScope.class);
		for (TurnCredentialRateLimitScope scope
				: TurnCredentialRateLimitScope.values()) {
			rateLimited.put(
					scope,
					Counter.builder("round.turn.credentials.rate_limited")
							.tag("scope", scope.metricTag())
							.description(
									"TURN credential requests rejected by an issuance quota")
							.register(registry));
		}
	}

	void recordIssued() {
		issued.increment();
	}

	void recordRateLimited(TurnCredentialRateLimitScope scope) {
		rateLimited.get(scope).increment();
	}
}
