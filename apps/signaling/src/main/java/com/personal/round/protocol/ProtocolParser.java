package com.personal.round.protocol;

import java.math.BigDecimal;
import java.util.Collection;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Component
public class ProtocolParser {

	public static final int PROTOCOL_VERSION = 1;
	public static final int MAX_ROOM_ID_LENGTH = 14;
	public static final int MAX_PEER_ID_LENGTH = 128;
	public static final int MAX_DISPLAY_NAME_LENGTH = 64;
	public static final int MAX_REQUEST_ID_LENGTH = 128;
	public static final int MAX_SDP_LENGTH = 64 * 1024;
	public static final int MAX_CANDIDATE_LENGTH = 8 * 1024;

	private static final Set<String> CLIENT_TYPES = Set.of(
			"room.join", "room.leave", "rtc.offer", "rtc.answer", "rtc.ice");
	private static final Pattern ROOM_ID_PATTERN = Pattern.compile(
			"[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}"
					+ "-[abcdefghjkmnpqrstuvwxyz23456789]{4}");

	private final ObjectMapper objectMapper;

	public ProtocolParser(ObjectMapper objectMapper) {
		this.objectMapper = objectMapper;
	}

	public ClientMessage parse(String rawMessage) {
		JsonNode parsed;
		try (JsonParser jsonParser = objectMapper.createParser(rawMessage)) {
			parsed = objectMapper.readTree(jsonParser);
			if (parsed == null || parsed.isMissingNode() || jsonParser.nextToken() != null) {
				throw new MalformedJsonException();
			}
		}
		catch (MalformedJsonException exception) {
			throw exception;
		}
		catch (Exception exception) {
			throw new MalformedJsonException();
		}

		ObjectNode message = object(parsed, "$");
		numericLiteral(message.get("v"), PROTOCOL_VERSION, "$.v");
		String type = requiredText(message.get("type"), "$.type");
		if (!CLIENT_TYPES.contains(type)) {
			throw fail("$.type", "must be one of room.join, rtc.offer, rtc.answer, rtc.ice, room.leave");
		}

		return switch (type) {
			case "room.join" -> parseJoin(message);
			case "room.leave" -> parseLeave(message);
			case "rtc.offer" -> parseDescriptionRelay(message, "offer");
			case "rtc.answer" -> parseDescriptionRelay(message, "answer");
			case "rtc.ice" -> parseIceRelay(message);
			default -> throw fail("$.type", "is not supported");
		};
	}

	private ClientMessage.Join parseJoin(ObjectNode message) {
		exactKeys(message, Set.of("v", "type", "roomId", "requestId", "payload"), "$");
		String roomId = roomId(message.get("roomId"), "$.roomId");
		String requestId = optionalNonBlankString(
				message, "requestId", MAX_REQUEST_ID_LENGTH, "$.requestId");
		ObjectNode payload = object(message.get("payload"), "$.payload");
		exactKeys(payload, Set.of("displayName"), "$.payload");
		String displayName = normalizedString(
				payload.get("displayName"), MAX_DISPLAY_NAME_LENGTH, "$.payload.displayName");
		return new ClientMessage.Join(roomId, requestId, displayName);
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
		exactKeys(payload, Set.of("description"), "$.payload");
		ObjectNode description = object(payload.get("description"), "$.payload.description");
		exactKeys(description, Set.of("type", "sdp"), "$.payload.description");
		textLiteral(description.get("type"), expectedType, "$.payload.description.type");
		if (description.has("sdp")) {
			boundedString(description.get("sdp"), MAX_SDP_LENGTH, "$.payload.description.sdp");
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
		exactKeys(payload, Set.of("candidate"), "$.payload");
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
				throw fail(path + "." + propertyName, "is not allowed");
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
		if (!ROOM_ID_PATTERN.matcher(value).matches()) {
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
		if (input == null || !input.isTextual()) {
			throw fail(path, "must be a string");
		}
		String value = input.asText();
		if (value.length() > maximumLength) {
			throw fail(path, "must contain at most " + maximumLength + " characters");
		}
		return value;
	}

	private static String requiredText(JsonNode input, String path) {
		if (input == null || !input.isTextual()) {
			throw fail(path, "must be a string");
		}
		return input.asText();
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
		if (!input.isNumber()) {
			throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
		}
		BigDecimal number = input.decimalValue().stripTrailingZeros();
		if (number.scale() > 0) {
			throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
		}
		try {
			int value = number.intValueExact();
			if (value < minimum || value > maximum) {
				throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
			}
		}
		catch (ArithmeticException exception) {
			throw fail(path, "must be null or an integer between " + minimum + " and " + maximum);
		}
	}

	private static void numericLiteral(JsonNode input, int expected, String path) {
		if (input == null || !input.isNumber()
				|| input.decimalValue().compareTo(BigDecimal.valueOf(expected)) != 0) {
			throw fail(path, "must equal " + expected);
		}
	}

	private static void textLiteral(JsonNode input, String expected, String path) {
		if (input == null || !input.isTextual() || !expected.equals(input.asText())) {
			throw fail(path, "must equal \"" + expected + "\"");
		}
	}

	private static ProtocolValidationException fail(String path, String reason) {
		return new ProtocolValidationException(path, reason);
	}

	private record RelayEnvelope(String roomId, String requestId, String to) {
	}
}
