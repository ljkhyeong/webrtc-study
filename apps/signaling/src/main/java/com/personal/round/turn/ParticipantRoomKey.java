package com.personal.round.turn;

import java.util.Objects;

record ParticipantRoomKey(
		String roomId,
		String subject) {

	ParticipantRoomKey {
		requireText(roomId, "roomId");
		requireText(subject, "subject");
	}

	@Override
	public String toString() {
		return "ParticipantRoomKey[redacted]";
	}

	private static void requireText(String value, String field) {
		Objects.requireNonNull(value, field + " must not be null");
		if (value.isBlank()) {
			throw new IllegalArgumentException(field + " must not be blank");
		}
	}
}
