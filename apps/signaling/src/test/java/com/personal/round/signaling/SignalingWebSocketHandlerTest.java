package com.personal.round.signaling;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.config.SignalingProperties;
import com.personal.round.protocol.ProtocolParser;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

class SignalingWebSocketHandlerTest {

	private SignalingService service;
	private SignalingWebSocketHandler handler;
	private WebSocketSession session;

	@BeforeEach
	void setUp() {
		service = mock(SignalingService.class);
		SignalingProperties properties = new SignalingProperties();
		handler = new SignalingWebSocketHandler(
				new ProtocolParser(new ObjectMapper()), service, properties);
		session = mock(WebSocketSession.class);
		when(session.getId()).thenReturn("session");
		when(service.acceptInboundFrame(session)).thenReturn(true);
	}

	@Test
	void returnsInvalidMessageForMalformedJson() throws Exception {
		handler.handleMessage(session, new TextMessage("{"));

		verify(service).sendInvalidMessage(session, "Message must be valid JSON.");
	}

	@Test
	void rejectsBinaryFramesWithoutTreatingThemAsJson() throws Exception {
		handler.handleMessage(
				session,
				new BinaryMessage("not-json".getBytes(StandardCharsets.UTF_8)));

		verify(service).sendInvalidMessage(session, "Binary messages are not supported.");
	}

	@Test
	void closesTextFramesLargerThan64KiB() throws Exception {
		when(session.isOpen()).thenReturn(true);
		String oversized = "x".repeat(64 * 1024 + 1);

		handler.handleMessage(session, new TextMessage(oversized));

		verify(session).close(new CloseStatus(1009, "Message exceeds 64 KiB"));
		verify(service).disconnect(session);
		verify(service, org.mockito.Mockito.never()).handle(any(), any());
	}

	@Test
	void stopsProcessingWhenTheAbuseLimiterRejectsAFrame() throws Exception {
		when(service.acceptInboundFrame(session)).thenReturn(false);

		handler.handleMessage(
				session,
				new TextMessage("""
						{"v":1,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
						"""));

		verify(service, org.mockito.Mockito.never()).handle(any(), any());
		verify(service, org.mockito.Mockito.never()).sendInvalidMessage(any(), any());
	}

	@Test
	void recordsPongLivenessBeforeApplyingFrameAccounting() throws Exception {
		when(service.acceptInboundFrame(session)).thenReturn(false);

		handler.handleMessage(session, new org.springframework.web.socket.PongMessage());

		org.mockito.InOrder order = org.mockito.Mockito.inOrder(service);
		order.verify(service).markAlive(session);
		order.verify(service).acceptInboundFrame(session);
	}
}
