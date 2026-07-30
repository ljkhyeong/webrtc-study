package com.personal.round.turn;

enum TurnCredentialRateLimitScope {

	CLIENT("client", 1),
	PARTICIPANT("participant", 2),
	GLOBAL("global", 3),
	CLIENT_STATE_CAPACITY("client_state_capacity", 4),
	PARTICIPANT_STATE_CAPACITY("participant_state_capacity", 5);

	private final String metricTag;
	private final int priority;

	TurnCredentialRateLimitScope(String metricTag, int priority) {
		this.metricTag = metricTag;
		this.priority = priority;
	}

	String metricTag() {
		return metricTag;
	}

	int priority() {
		return priority;
	}
}
