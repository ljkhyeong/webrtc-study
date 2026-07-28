package com.personal.round.protocol;

import tools.jackson.databind.node.ObjectNode;

public sealed interface ClientMessage
		permits ClientMessage.Join, ClientMessage.Leave, ClientMessage.Relay {

	String type();

	String roomId();

	String requestId();

	record Join(String roomId, String requestId, String displayName) implements ClientMessage {

		@Override
		public String type() {
			return "room.join";
		}
	}

	record Leave(String roomId, String requestId) implements ClientMessage {

		@Override
		public String type() {
			return "room.leave";
		}
	}

	record Relay(
			String type,
			String roomId,
			String requestId,
			String to,
			ObjectNode payload) implements ClientMessage {
	}
}
