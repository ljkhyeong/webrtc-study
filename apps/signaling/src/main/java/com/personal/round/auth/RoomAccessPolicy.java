package com.personal.round.auth;

import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

@Component
public final class RoomAccessPolicy {

	private final RoundAuthProperties properties;

	public RoomAccessPolicy(RoundAuthProperties properties) {
		this.properties = properties;
	}

	public Optional<RoomAccess> resolve(WebSocketSession session) {
		if (!properties.batonMode()) {
			return Optional.of(StandaloneRoomAccess.INSTANCE);
		}
		Map<String, Object> attributes = session.getAttributes();
		if (attributes == null) {
			return Optional.empty();
		}
		Object candidate = attributes.get(ParticipationGrant.SESSION_ATTRIBUTE);
		return candidate instanceof ParticipationGrant grant
				? Optional.of(grant)
				: Optional.empty();
	}
}
