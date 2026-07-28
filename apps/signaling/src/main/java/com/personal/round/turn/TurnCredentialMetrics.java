package com.personal.round.turn;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

@Component
public final class TurnCredentialMetrics {

	private final Counter issued;
	private final Counter rateLimited;

	public TurnCredentialMetrics(MeterRegistry registry) {
		issued = Counter.builder("round.turn.credentials.issued")
				.description("TURN credentials successfully issued")
				.register(registry);
		rateLimited = Counter.builder("round.turn.credentials.rate_limited")
				.description("TURN credential requests rejected by an issuance quota")
				.register(registry);
	}

	void recordIssued() {
		issued.increment();
	}

	void recordRateLimited() {
		rateLimited.increment();
	}
}
