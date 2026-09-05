package com.personal.round.protocol;

import java.util.Set;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import tools.jackson.databind.node.ObjectNode;

@Component
public class ProtocolParser {

	public static final int PROTOCOL_VERSION = 3;
	public static final int MAX_PEER_ID_LENGTH = 128;
	public static final int MAX_DISPLAY_NAME_LENGTH = 64;
	public static final int MAX_REQUEST_ID_LENGTH = 128;
	public static final int MIN_HOST_CAPABILITY_LENGTH = 32;
	public static final int MAX_HOST_CAPABILITY_LENGTH = 256;
	public static final int MAX_SIGNALING_FRAME_BYTES = 64 * 1024;
	public static final int MAX_SDP_BYTES = 48 * 1024;
	public static final int MAX_CANDIDATE_LENGTH = 8 * 1024;

	private final ObjectReader objectReader;

	public ProtocolParser(ObjectMapper objectMapper) {
		this.objectReader = objectMapper.reader(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
	}

	public ClientMessage parse(String rawMessage) {
		if (rawMessage == null) {
			throw new MalformedJsonException();
		}

		JsonNode parsed;
		try {
			parsed = objectReader.readTree(rawMessage);
		}
		catch (JacksonException exception) {
			throw new MalformedJsonException();
		}

		ObjectNode message = object(parsed, "$");
		numericLiteral(message.get("v"), PROTOCOL_VERSION, "$.v");
		String type = requiredText(message.get("type"), "$.type");
		return switch (type) {
			case "room.join" -> parseJoin(message);
			case "room.leave" -> parseLeave(message);
			case "peer.reconnect" -> parseReconnect(message);
			case "room.study.sync", "room.study.update" -> parseStudy(message, type);
			case "room.hand.sync", "room.hand.update" -> parseHand(message, type);
			case "rtc.offer" -> parseDescriptionRelay(message, "offer");
			case "rtc.answer" -> parseDescriptionRelay(message, "answer");
			case "rtc.ice" -> parseIceRelay(message);
			case "moderation.media.disable" -> parseModeration(message);
			default -> throw fail("$.type", "must be a supported client message type");
		};
	}

	private ClientMessage.Hand parseHand(ObjectNode message, String type) {
		boolean sync = type.equals("room.hand.sync");
		exactKeys(message, sync ? Set.of("v", "type", "roomId", "requestId")
				: Set.of("v", "type", "roomId", "requestId", "payload"), "$");
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		if (sync) return new ClientMessage.Hand(roomId, requestId, null);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("raised"), "$.payload");
		JsonNode raised = payload.get("raised");
		if (raised == null || !raised.isBoolean()) throw fail("$.payload.raised", "must be boolean");
		return new ClientMessage.Hand(roomId, requestId, raised.asBoolean());
	}

	private ClientMessage.Study parseStudy(ObjectNode message, String type) {
		boolean sync = type.equals("room.study.sync");
		exactKeys(message, sync ? Set.of("v", "type", "roomId", "requestId")
				: Set.of("v", "type", "roomId", "requestId", "payload"), "$");
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		if (sync) return new ClientMessage.Study(roomId, requestId, null);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		String action = requiredText(payload.get("action"), "$.payload.action");
		long revision = boundedInteger(payload.get("expectedRevision"), 0, 9_007_199_254_740_991L, "$.payload.expectedRevision");
		String topic = null;
		String mode = null;
		int duration = 0;
		switch (action) {
			case "start" -> {
				exactKeys(payload, Set.of("action", "expectedRevision", "mode", "durationSeconds"), "$.payload");
				mode = requiredText(payload.get("mode"), "$.payload.mode");
				if (!mode.equals("focus") && !mode.equals("break")) throw fail("$.payload.mode", "must be focus or break");
				duration = (int) boundedInteger(payload.get("durationSeconds"), 60, 7200, "$.payload.durationSeconds");
			}
			case "topic" -> {
				exactKeys(payload, Set.of("action", "expectedRevision", "topic"), "$.payload");
				topic = boundedString(payload.get("topic"), 120, "$.payload.topic");
			}
			case "pause", "resume", "reset" -> exactKeys(payload, Set.of("action", "expectedRevision"), "$.payload");
			default -> throw fail("$.payload.action", "must be a supported study action");
		}
		return new ClientMessage.Study(roomId, requestId, new ClientMessage.StudyCommand(action, revision, topic, mode, duration));
	}

	private static long boundedInteger(JsonNode value, long minimum, long maximum, String path) {
		if (value == null || !value.canConvertToLong()) {
			throw fail(path, "must be an integer within the allowed range");
		}
		long number = value.longValue();
		if (number < minimum || number > maximum) {
			throw fail(path, "must be an integer within the allowed range");
		}
		return number;
	}

	private ClientMessage.Reconnect parseReconnect(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "to"), "$");
		RelayEnvelope envelope = relayEnvelope(message);
		return new ClientMessage.Reconnect(envelope.roomId(), envelope.requestId(), envelope.to());
	}

	private ClientMessage.Join parseJoin(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "payload"), "$");
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(
				message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("displayName", "hostCapability"), "$.payload");
		String displayName = normalizedString(
				payload.get("displayName"), MAX_DISPLAY_NAME_LENGTH, "$.payload.displayName");
		String hostCapability = optionalNonBlankString(
				payload,
				"hostCapability",
				MAX_HOST_CAPABILITY_LENGTH,
				"$.payload.hostCapability");
		if (hostCapability != null && hostCapability.length() < MIN_HOST_CAPABILITY_LENGTH) {
			throw fail(
					"$.payload.hostCapability",
					"must contain at least " + MIN_HOST_CAPABILITY_LENGTH + " characters");
		}
		return new ClientMessage.Join(roomId, requestId, displayName, hostCapability);
	}

	private ClientMessage.Moderation parseModeration(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "to", "payload"), "$");
		RelayEnvelope envelope = relayEnvelope(message);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("kind"), "$.payload");
		String kind = requiredText(payload.get("kind"), "$.payload.kind");
		ClientMessage.MediaKind mediaKind = switch (kind) {
			case "audio" -> ClientMessage.MediaKind.AUDIO;
			case "video" -> ClientMessage.MediaKind.VIDEO;
			default -> throw fail("$.payload.kind", "must be one of audio, video");
		};
		return new ClientMessage.Moderation(
				envelope.roomId(), envelope.requestId(), envelope.to(), mediaKind);
	}

	private ClientMessage.Leave parseLeave(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId"), "$");
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(
				message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		return new ClientMessage.Leave(roomId, requestId);
	}

	private ClientMessage.Relay parseDescriptionRelay(ObjectNode message, String expectedType) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "to", "payload"), "$");
		RelayEnvelope envelope = relayEnvelope(message);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("description", "negotiationId"), "$.payload");
		optionalNonBlankString(
				payload, "negotiationId", MAX_REQUEST_ID_LENGTH, "$.payload.negotiationId");
		ObjectNode description = object(payload.get("description"), "$.payload.description");
		exactKeys(description, Set.of("type", "sdp"), "$.payload.description");
		textLiteral(description.get("type"), expectedType, "$.payload.description.type");
		JsonNode sdp = description.get("sdp");
		if (sdp != null) {
			boundedUtf8String(sdp, MAX_SDP_BYTES, "$.payload.description.sdp");
		}
		return new ClientMessage.Relay(
				"rtc." + expectedType,
				envelope.roomId(),
				envelope.requestId(),
				envelope.to(),
				payload);
	}

	private ClientMessage.Relay parseIceRelay(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "to", "payload"), "$");
		RelayEnvelope envelope = relayEnvelope(message);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("candidate", "negotiationId"), "$.payload");
		optionalNonBlankString(
				payload, "negotiationId", MAX_REQUEST_ID_LENGTH, "$.payload.negotiationId");
		JsonNode candidateNode = payload.get("candidate");
		if (candidateNode == null) {
			throw fail("$.payload.candidate", "is required");
		}
		if (!candidateNode.isNull()) {
			validateIceCandidate(candidateNode);
		}
		return new ClientMessage.Relay(
				"rtc.ice",
				envelope.roomId(),
				envelope.requestId(),
				envelope.to(),
				payload);
	}

	private RelayEnvelope relayEnvelope(ObjectNode message) {
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(
				message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		String to = nonBlankString(message.get("to"), MAX_PEER_ID_LENGTH, "$.to");
		return new RelayEnvelope(roomId, requestId, to);
	}

	private void validateIceCandidate(JsonNode candidateNode) {
		ObjectNode candidate = object(candidateNode, "$.payload.candidate");
		exactKeys(candidate, Set.of(
				"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"), "$.payload.candidate");
		boundedString(
				candidate.get("candidate"), MAX_CANDIDATE_LENGTH, "$.payload.candidate.candidate");
		nullableOptionalString(candidate, "sdpMid", 256, "$.payload.candidate.sdpMid");
		nullableOptionalInteger(
				candidate, "sdpMLineIndex", 0, 65_535, "$.payload.candidate.sdpMLineIndex");
		nullableOptionalString(
				candidate, "usernameFragment", 256, "$.payload.candidate.usernameFragment");
	}

	private static ObjectNode object(JsonNode input, String path) {
		if (!(input instanceof ObjectNode object)) {
			throw fail(path, "must be an object");
		}
		return object;
	}

	private static void exactKeys(ObjectNode input, Set<String> allowedKeys, String path) {
		if (!allowedKeys.containsAll(input.propertyNames())) {
			throw fail(path, "contains an unsupported property");
		}
	}

	private static String normalizedString(JsonNode input, int maximumLength, String path) {
		String value = nonBlankString(input, maximumLength, path);
		if (isEcmaScriptWhitespace(value.charAt(0))
				|| isEcmaScriptWhitespace(value.charAt(value.length() - 1))) {
			throw fail(path, "must not start or end with whitespace");
		}
		return value;
	}

	private static String roomId(JsonNode input, String path) {
		String value = requiredText(input, path);
		if (!RoomIdFormat.isCanonical(value)) {
			throw fail(
					path,
					"must contain three lowercase four-character invite segments separated by hyphens");
		}
		return value;
	}

	private static String optionalNonBlankString(
			ObjectNode parent,
			String key,
			int maximumLength,
			String path) {
		JsonNode input = parent.get(key);
		if (input == null) {
			return null;
		}
		return nonBlankString(input, maximumLength, path);
	}

	private static String nonBlankString(JsonNode input, int maximumLength, String path) {
		String value = boundedString(input, maximumLength, path);
		if (value.chars().allMatch(character -> isEcmaScriptWhitespace((char) character))) {
			throw fail(path, "must not be blank");
		}
		return value;
	}

	private static boolean isEcmaScriptWhitespace(char character) {
		// ECMAScript trim은 Unicode 공백 외에 ASCII 제어 공백과 BOM도 제거한다.
		return Character.isSpaceChar(character)
				|| (character >= '\t' && character <= '\r')
				|| character == '\uFEFF';
	}

	private static String boundedString(JsonNode input, int maximumLength, String path) {
		String value = requiredText(input, path);
		if (value.length() > maximumLength) {
			throw fail(path, "must contain at most " + maximumLength + " characters");
		}
		return value;
	}

	private static String boundedUtf8String(JsonNode input, int maximumBytes, String path) {
		String value = requiredText(input, path);
		if (utf8ByteLength(value) > maximumBytes) {
			throw fail(path, "must contain at most " + maximumBytes + " UTF-8 bytes");
		}
		return value;
	}

	private static long utf8ByteLength(String value) {
		long bytes = 0;
		for (int index = 0; index < value.length(); index++) {
			char codeUnit = value.charAt(index);
			if (codeUnit <= 0x007F) {
				bytes += 1;
			}
			else if (codeUnit <= 0x07FF) {
				bytes += 2;
			}
			else if (Character.isHighSurrogate(codeUnit)
					&& index + 1 < value.length()
					&& Character.isLowSurrogate(value.charAt(index + 1))) {
				bytes += 4;
				index++;
			}
			else {
				// TextEncoder와 일치하도록 짝이 없는 서로게이트를 U+FFFD로 처리한다.
				bytes += 3;
			}
		}
		return bytes;
	}

	private static String requiredText(JsonNode input, String path) {
		if (input == null || !input.isString()) {
			throw fail(path, "must be a string");
		}
		return input.asString();
	}

	private static void nullableOptionalString(
			ObjectNode parent,
			String key,
			int maximumLength,
			String path) {
		JsonNode input = parent.get(key);
		if (input == null || input.isNull()) {
			return;
		}
		boundedString(input, maximumLength, path);
	}

	private static void nullableOptionalInteger(
			ObjectNode parent,
			String key,
			int minimum,
			int maximum,
			String path) {
		JsonNode input = parent.get(key);
		if (input == null || input.isNull()) {
			return;
		}
		if (!input.canConvertToInt()) {
			throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
		}
		int value = input.intValue();
		if (value < minimum || value > maximum) {
			throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
		}
	}

	private static void numericLiteral(JsonNode input, int expected, String path) {
		if (input == null || !input.canConvertToInt() || input.intValue() != expected) {
			throw fail(path, "must equal " + expected);
		}
	}

	private static void textLiteral(JsonNode input, String expected, String path) {
		if (input == null || !input.isString() || !expected.equals(input.asString())) {
			throw fail(path, "must equal \"" + expected + "\"");
		}
	}

	private static ProtocolValidationException fail(String path, String reason) {
		return new ProtocolValidationException(path, reason);
	}

	private record RelayEnvelope(String roomId, String requestId, String to) {
	}
}
