package com.personal.round.protocol;

import tools.jackson.databind.node.ObjectNode;

public sealed interface ClientMessage
		permits ClientMessage.Join, ClientMessage.Leave, ClientMessage.Relay, ClientMessage.Moderation, ClientMessage.Reconnect, ClientMessage.Study {

	String type();

	String roomId();

	String requestId();

	record Join(String roomId, String requestId, String displayName, String hostCapability)
			implements ClientMessage {

		@Override
		public String type() {
			return "room.join";
		}

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

		@Override
		public String type() {
			return "room.leave";
		}
	}

	record Study(String roomId, String requestId, StudyCommand command) implements ClientMessage {
		@Override
		public String type() { return command == null ? "room.study.sync" : "room.study.update"; }
	}

	record StudyCommand(String action, long expectedRevision, String topic, String mode, int durationSeconds) { }

	record Reconnect(String roomId, String requestId, String to) implements ClientMessage {
		@Override
		public String type() {
			return "peer.reconnect";
		}
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

		@Override
		public String type() {
			return "moderation.media.disable";
		}
	}

	enum MediaKind {
		AUDIO,
		VIDEO;

		public String wireValue() {
			return name().toLowerCase(java.util.Locale.ROOT);
		}
	}
}
