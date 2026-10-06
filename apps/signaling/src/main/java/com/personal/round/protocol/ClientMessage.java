package com.personal.round.protocol;

import com.fasterxml.jackson.annotation.JsonProperty;
import tools.jackson.databind.node.ObjectNode;

public sealed interface ClientMessage
		permits ClientMessage.Join, ClientMessage.Leave, ClientMessage.Relay, ClientMessage.Moderation, ClientMessage.Reconnect, ClientMessage.Study, ClientMessage.Hand {

	String roomId();

	String requestId();

	record Hand(String roomId, String requestId, Boolean raised) implements ClientMessage {
	}

	record Join(String roomId, String requestId, String displayName, String hostCapability)
			implements ClientMessage {

		@Override
		public String toString() {
			return "Join[roomId=%s, requestId=%s, displayName=%s, hostCapability=%s]"
					.formatted(
							roomId,
							requestId,
							displayName,
							hostCapability == null ? "null" : "<redacted>");
		}
	}

	record Leave(String roomId, String requestId) implements ClientMessage {
	}

	record Study(String roomId, String requestId, StudyCommand command) implements ClientMessage {
	}

	record StudyCommand(String action, long expectedRevision, String topic, String mode, int durationSeconds) { }

	record Reconnect(String roomId, String requestId, String to) implements ClientMessage {
	}

	record Relay(
			String type,
			String roomId,
			String requestId,
			String to,
			ObjectNode payload) implements ClientMessage {
	}

	record Moderation(
			String roomId,
			String requestId,
			String to,
			MediaKind kind) implements ClientMessage {
	}

	enum MediaKind {
		@JsonProperty("audio")
		AUDIO,
		@JsonProperty("video")
		VIDEO
	}
}
