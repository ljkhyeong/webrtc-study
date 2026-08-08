package com.personal.round.signaling;

import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.MalformedJsonException;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.protocol.ProtocolValidationException;
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
			CloseStatus.TOO_BIG_TO_PROCESS.withReason("Message exceeds 64 KiB");

	private final ProtocolParser parser;
	private final SignalingService signalingService;
	private final int maxTextPayloadBytes;

	public SignalingWebSocketHandler(
			ProtocolParser parser,
			SignalingService signalingService,
			SignalingProperties properties) {
		this.parser = parser;
		this.signalingService = signalingService;
		this.maxTextPayloadBytes = properties.maxTextPayloadBytes();
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		try {
			session.setTextMessageSizeLimit(maxTextPayloadBytes);
			session.setBinaryMessageSizeLimit(maxTextPayloadBytes);
			signalingService.connect(session);
		}
		finally {
			signalingService.releaseUnclaimedReservation(session);
		}
	}

	@Override
	protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
		int payloadBytes = message.getPayloadLength();
		if (payloadBytes > maxTextPayloadBytes) {
			signalingService.recordInvalidFrame();
			signalingService.disconnectAndClose(session, MESSAGE_TOO_BIG);
			return;
		}
		if (!signalingService.acceptInboundFrame(session, payloadBytes)) {
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
			log.error("Unexpected signaling failure", exception);
			signalingService.sendInternalError(session);
		}
	}

	@Override
	protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
		if (!signalingService.acceptInboundFrame(session, message.getPayloadLength())) {
			return;
		}
		signalingService.sendInvalidMessage(session, "Binary messages are not supported.");
	}

	@Override
	protected void handlePongMessage(WebSocketSession session, PongMessage message) {
		signalingService.acceptInboundFrame(session, message.getPayloadLength());
		var payload = message.getPayload().asReadOnlyBuffer();
		byte[] payloadBytes = new byte[payload.remaining()];
		payload.get(payloadBytes);
		signalingService.markAlive(session, payloadBytes);
	}

	@Override
	public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
		log.debug(
				"WebSocket transport error; closing transport ({})",
				exception.getClass().getSimpleName());
		signalingService.disconnectAndClose(session, CloseStatus.SERVER_ERROR);
	}

	@Override
	public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
		signalingService.disconnect(session);
	}
}
