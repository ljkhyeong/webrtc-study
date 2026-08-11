package com.personal.round.protocol;

import java.util.Collection;
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
	public static final int MAX_ROOM_ID_LENGTH = RoomIdFormat.MAX_LENGTH;
	public static final int MAX_PEER_ID_LENGTH = 128;
	public static final int MAX_DISPLAY_NAME_LENGTH = 64;
	public static final int MAX_REQUEST_ID_LENGTH = 128;
	public static final int MIN_HOST_CAPABILITY_LENGTH = 32;
	public static final int MAX_HOST_CAPABILITY_LENGTH = 256;
	public static final int MAX_NEGOTIATION_ID_LENGTH = MAX_REQUEST_ID_LENGTH;
	public static final int MAX_SIGNALING_FRAME_BYTES = 64 * 1024;
	public static final int MAX_SDP_BYTES = 48 * 1024;
	public static final int MAX_CANDIDATE_LENGTH = 8 * 1024;

	private static final Set<String> CLIENT_TYPES = Set.of(
			"room.join", "room.leave", "rtc.offer", "rtc.answer", "rtc.ice",
			"moderation.media.disable");
	private final ObjectReader objectReader;

	public ProtocolParser(ObjectMapper objectMapper) {
		this.objectReader = objectMapper.reader(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
	}

	public ClientMessage parse(String rawMessage) {
		if (rawMessage == null) {
			throw new MalformedJsonException();
		}
		if (utf8ByteLength(rawMessage) > MAX_SIGNALING_FRAME_BYTES) {
			throw fail(
					"$",
					"serialized message must contain at most "
							+ MAX_SIGNALING_FRAME_BYTES
							+ " UTF-8 bytes");
		}

		JsonNode parsed;
		try {
			parsed = objectReader.readTree(rawMessage);
		}
		catch (JacksonException exception) {
			throw new MalformedJsonException();
		}
		if (parsed == null || parsed.isMissingNode()) {
			throw new MalformedJsonException();
		}

		ObjectNode message = object(parsed, "$");
		numericLiteral(message.get("v"), PROTOCOL_VERSION, "$.v");
		String type = requiredText(message.get("type"), "$.type");
		if (!CLIENT_TYPES.contains(type)) {
			throw fail("$.type", "must be a supported client message type");
		}

		return switch (type) {
			case "room.join" -> parseJoin(message);
			case "room.leave" -> parseLeave(message);
			case "rtc.offer" -> parseDescriptionRelay(message, "offer");
			case "rtc.answer" -> parseDescriptionRelay(message, "answer");
			case "rtc.ice" -> parseIceRelay(message);
			case "moderation.media.disable" -> parseModeration(message);
			default -> throw fail("$.type", "is not supported");
		};
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
				payload, "negotiationId", MAX_NEGOTIATION_ID_LENGTH, "$.payload.negotiationId");
		ObjectNode description = object(payload.get("description"), "$.payload.description");
		exactKeys(description, Set.of("type", "sdp"), "$.payload.description");
		textLiteral(description.get("type"), expectedType, "$.payload.description.type");
		if (description.has("sdp")) {
			boundedUtf8String(description.get("sdp"), MAX_SDP_BYTES, "$.payload.description.sdp");
		}
		return new ClientMessage.Relay(
				"rtc." + expectedType,
				envelope.roomId(),
				envelope.requestId(),
				envelope.to(),
				payload.deepCopy());
	}

	private ClientMessage.Relay parseIceRelay(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "to", "payload"), "$");
		RelayEnvelope envelope = relayEnvelope(message);
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("candidate", "negotiationId"), "$.payload");
		optionalNonBlankString(
				payload, "negotiationId", MAX_NEGOTIATION_ID_LENGTH, "$.payload.negotiationId");
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
				payload.deepCopy());
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
		Collection<String> propertyNames = input.propertyNames();
		for (String propertyName : propertyNames) {
			if (!allowedKeys.contains(propertyName)) {
				throw fail(path, "contains an unsupported property");
			}
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
		String value = boundedString(input, MAX_ROOM_ID_LENGTH, path);
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
		if (!parent.has(key)) {
			return null;
		}
		return nonBlankString(parent.get(key), maximumLength, path);
	}

	private static String nonBlankString(JsonNode input, int maximumLength, String path) {
		String value = boundedString(input, maximumLength, path);
		if (value.chars().allMatch(character -> isEcmaScriptWhitespace((char) character))) {
			throw fail(path, "must not be blank");
		}
		return value;
	}

	private static boolean isEcmaScriptWhitespace(char character) {
		return character == '\t'
				|| character == '\n'
				|| character == 0x000B
				|| character == '\f'
				|| character == '\r'
				|| character == ' '
				|| character == '\u00A0'
				|| character == '\u1680'
				|| (character >= '\u2000' && character <= '\u200A')
				|| character == '\u2028'
				|| character == '\u2029'
				|| character == '\u202F'
				|| character == '\u205F'
				|| character == '\u3000'
				|| character == '\uFEFF';
	}

	private static String boundedString(JsonNode input, int maximumLength, String path) {
		if (input == null || !input.isString()) {
			throw fail(path, "must be a string");
		}
		String value = input.asString();
		if (value.length() > maximumLength) {
			throw fail(path, "must contain at most " + maximumLength + " characters");
		}
		return value;
	}

	private static String boundedUtf8String(JsonNode input, int maximumBytes, String path) {
		if (input == null || !input.isString()) {
			throw fail(path, "must be a string");
		}
		String value = input.asString();
		if (utf8ByteLength(value) > maximumBytes) {
			throw fail(path, "must contain at most " + maximumBytes + " UTF-8 bytes");
		}
		return value;
	}

	static long utf8ByteLength(String value) {
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
				// Match TextEncoder: an unpaired surrogate becomes U+FFFD.
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
		if (!parent.has(key) || parent.get(key).isNull()) {
			return;
		}
		boundedString(parent.get(key), maximumLength, path);
	}

	private static void nullableOptionalInteger(
			ObjectNode parent,
			String key,
			int minimum,
			int maximum,
			String path) {
		if (!parent.has(key) || parent.get(key).isNull()) {
			return;
		}
		JsonNode input = parent.get(key);
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
