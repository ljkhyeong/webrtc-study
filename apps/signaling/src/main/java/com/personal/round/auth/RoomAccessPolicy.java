package com.personal.round.auth;

import java.util.Optional;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

@Component
public final class RoomAccessPolicy {

	private final RoundAuthProperties properties;
	private final StandaloneRoomAccess standaloneRoomAccess;

	public RoomAccessPolicy(RoundAuthProperties properties) {
		this.properties = properties;
		this.standaloneRoomAccess = new StandaloneRoomAccess(
				properties.standaloneHostTokenSha256());
	}

	public Optional<RoomAccess> resolve(WebSocketSession session) {
		if (!properties.batonMode()) {
			return Optional.of(standaloneRoomAccess);
		}
		Object candidate = session.getAttributes().get(ParticipationGrant.SESSION_ATTRIBUTE);
		return candidate instanceof ParticipationGrant grant
				? Optional.of(grant)
				: Optional.empty();
	}
}
