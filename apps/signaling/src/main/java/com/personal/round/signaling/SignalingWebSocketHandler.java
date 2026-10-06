package com.personal.round.signaling;

import com.personal.round.protocol.ClientMessage;
import com.personal.round.protocol.ProtocolParser;
import com.personal.round.protocol.ProtocolValidationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

// 바이너리 프레임은 TextWebSocketHandler가 1003(NOT_ACCEPTABLE)으로 닫는다.
@Component
public class SignalingWebSocketHandler extends TextWebSocketHandler {

	private static final Logger log = LoggerFactory.getLogger(SignalingWebSocketHandler.class);
	private static final CloseStatus MESSAGE_TOO_BIG =
			CloseStatus.TOO_BIG_TO_PROCESS.withReason("Message exceeds 64 KiB");

	private final ProtocolParser parser;
	private final SignalingService signalingService;

	public SignalingWebSocketHandler(
			ProtocolParser parser,
			SignalingService signalingService) {
		this.parser = parser;
		this.signalingService = signalingService;
	}

	@Override
	public void afterConnectionEstablished(WebSocketSession session) {
		signalingService.connect(session);
	}

	@Override
	protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
		int payloadBytes = message.getPayloadLength();
		if (payloadBytes > ProtocolParser.MAX_SIGNALING_FRAME_BYTES) {
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
		catch (ProtocolValidationException exception) {
			signalingService.sendInvalidMessage(session, exception.getMessage());
		}
		catch (RuntimeException exception) {
			log.error(
					"Unexpected signaling failure ({})",
					exception.getClass().getSimpleName());
			signalingService.sendInternalError(session);
		}
	}

	@Override
	protected void handlePongMessage(WebSocketSession session, PongMessage message) {
		signalingService.acceptInboundFrame(session, message.getPayloadLength());
		signalingService.markAlive(session, message.getPayload());
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
