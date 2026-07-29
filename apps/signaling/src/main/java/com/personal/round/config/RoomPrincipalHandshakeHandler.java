package com.personal.round.config;

import com.personal.round.auth.ParticipationGrant;
import java.security.Principal;
import java.util.Map;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

final class RoomPrincipalHandshakeHandler extends DefaultHandshakeHandler {

	@Override
	protected Principal determineUser(
			ServerHttpRequest request,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes) {
		Object candidate = attributes.get(ParticipationGrant.SESSION_ATTRIBUTE);
		if (candidate instanceof ParticipationGrant grant) {
			return verifiedParticipantPrincipal(grant);
		}
		return super.determineUser(request, wsHandler, attributes);
	}

	static Principal verifiedParticipantPrincipal(ParticipationGrant grant) {
		return new VerifiedParticipantPrincipal(grant.subject());
	}

	private static final class VerifiedParticipantPrincipal implements Principal {

		private final String name;

		private VerifiedParticipantPrincipal(String name) {
			this.name = name;
		}

		@Override
		public String getName() {
			return name;
		}

		@Override
		public String toString() {
			return "VerifiedParticipantPrincipal";
		}
	}
}
