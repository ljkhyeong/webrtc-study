package com.personal.round.config;

public final class RoundRoutes {

	public static final String STANDALONE_SIGNAL = "/signal";
	public static final String STANDALONE_TURN_CREDENTIALS = "/api/turn-credentials";

	public static final String BATON_SIGNAL_TEMPLATE = "/rooms/{roomId}/signal";
	public static final String BATON_TURN_CREDENTIALS_TEMPLATE =
			"/api/rooms/{roomId}/turn-credentials";

	public static final String BATON_SIGNAL_SECURITY_PATTERN = "/rooms/*/signal";
	public static final String BATON_TURN_CREDENTIALS_SECURITY_PATTERN =
			"/api/rooms/*/turn-credentials";

	private RoundRoutes() {
	}
}
