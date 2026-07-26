package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.MalformedJsonException;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.protocol.ProtocolValidationException;
import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

@Component
public class SignalingWebSocketHandler extends AbstractWebSocketHandler {

	private static final Logger log = LoggerFactory.getLogger(SignalingWebSocketHandler.class);
	private static final CloseStatus MESSAGE_TOO_BIG =
			new CloseStatus(1009, "Message exceeds 64 KiB");

	private final ProtocolParser parser;
	private final SignalingService signalingService;
	private final int maxTextPayloadBytes;

	public SignalingWebSocketHandler(
			ProtocolParser parser,
			SignalingService signalingService,
			SignalingProperties properties) {
		this.parser = parser;
		this.signalingService = signalingService;
		this.maxTextPayloadBytes = properties.getMaxTextPayloadBytes();
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		session.setTextMessageSizeLimit(maxTextPayloadBytes);
		session.setBinaryMessageSizeLimit(maxTextPayloadBytes);
		signalingService.connect(session);
	}

	@Override
	protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
		if (message.getPayload().getBytes(StandardCharsets.UTF_8).length > maxTextPayloadBytes) {
			session.close(MESSAGE_TOO_BIG);
			signalingService.disconnect(session);
			return;
		}

		try {
			ClientMessage clientMessage = parser.parse(message.getPayload());
			signalingService.handle(session, clientMessage);
		}
		catch (MalformedJsonException exception) {
			signalingService.sendInvalidMessage(session, "Message must be valid JSON.");
		}
		catch (ProtocolValidationException exception) {
			signalingService.sendInvalidMessage(session, exception.getMessage());
		}
		catch (RuntimeException exception) {
			log.error("Unexpected signaling failure for session {}", session.getId(), exception);
			signalingService.sendInternalError(session);
		}
	}

	@Override
	protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
		signalingService.sendInvalidMessage(session, "Binary messages are not supported.");
	}

	@Override
	protected void handlePongMessage(WebSocketSession session, PongMessage message) {
		signalingService.markAlive(session);
	}

	@Override
	public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
		log.debug("WebSocket transport error for session {}", session.getId(), exception);
		signalingService.disconnect(session);
		if (session.isOpen()) {
			session.close(CloseStatus.SERVER_ERROR);
		}
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		signalingService.disconnect(session);
	}
}
