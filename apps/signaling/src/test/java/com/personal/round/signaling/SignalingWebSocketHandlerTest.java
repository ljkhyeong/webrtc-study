package com.personal.round.signaling;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.AdditionalMatchers.aryEq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.personal.round.config.TestProperties;
import com.personal.round.protocol.ProtocolParser;
import java.nio.ByteBuffer;
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
		handler = new SignalingWebSocketHandler(
				new ProtocolParser(new ObjectMapper()), service, TestProperties.signaling());
		session = mock(WebSocketSession.class);
		when(session.getId()).thenReturn("session");
		when(service.acceptInboundFrame(any(WebSocketSession.class), anyInt())).thenReturn(true);
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

		var order = inOrder(service, session);
		order.verify(service).recordInvalidFrame();
		order.verify(service).disconnectAndClose(
				session,
				new CloseStatus(1009, "Message exceeds 64 KiB"));
		verify(session, never()).close(any(CloseStatus.class));
		verify(service, org.mockito.Mockito.never()).handle(any(), any());
	}

	@Test
	void delegatesTransportErrorClosePolicyToTheSignalingService() throws Exception {
		handler.handleTransportError(session, new java.io.IOException("transport failed"));

		verify(service).disconnectAndClose(session, CloseStatus.SERVER_ERROR);
		verify(session, never()).close(any(CloseStatus.class));
	}

	@Test
	void stopsProcessingWhenTheAbuseLimiterRejectsAFrame() throws Exception {
		when(service.acceptInboundFrame(any(WebSocketSession.class), anyInt())).thenReturn(false);

		handler.handleMessage(
				session,
				new TextMessage("""
						{"v":3,"type":"room.leave","roomId":"abcd-efgh-jkmp"}
						"""));

		verify(service, org.mockito.Mockito.never()).handle(any(), any());
		verify(service, org.mockito.Mockito.never()).sendInvalidMessage(any(), any());
	}

	@Test
	void appliesFrameAccountingBeforeRecordingMatchingPongLiveness() throws Exception {
		byte[] challenge = "round-heartbeat".getBytes(StandardCharsets.UTF_8);

		handler.handleMessage(
				session,
				new org.springframework.web.socket.PongMessage(ByteBuffer.wrap(challenge)));

		org.mockito.InOrder order = org.mockito.Mockito.inOrder(service);
		order.verify(service).acceptInboundFrame(session, challenge.length);
		order.verify(service).markAlive(
				org.mockito.ArgumentMatchers.eq(session),
				aryEq(challenge));
	}

	@Test
	void stillPassesARejectedPongToNonceValidationAfterFrameAccounting() throws Exception {
		when(service.acceptInboundFrame(any(WebSocketSession.class), anyInt())).thenReturn(false);

		handler.handleMessage(session, new org.springframework.web.socket.PongMessage());

		org.mockito.InOrder order = org.mockito.Mockito.inOrder(service);
		order.verify(service).acceptInboundFrame(session, 0);
		order.verify(service).markAlive(
				org.mockito.ArgumentMatchers.eq(session),
				aryEq(new byte[0]));
	}

	@Test
	void accountsForUtf8BytesBeforeParsingText() throws Exception {
		String malformedMultibytePayload = "{\"name\":\"한\"";

		handler.handleMessage(session, new TextMessage(malformedMultibytePayload));

		verify(service).acceptInboundFrame(
				session,
				malformedMultibytePayload.getBytes(StandardCharsets.UTF_8).length);
	}

	@Test
	void releasesAnUnclaimedReservationWhenSessionInitializationFails() {
		doThrow(new IllegalStateException("container rejected message limit"))
				.when(session)
				.setTextMessageSizeLimit(anyInt());

		assertThatThrownBy(() -> handler.afterConnectionEstablished(session))
				.isInstanceOf(IllegalStateException.class);

		verify(service).releaseUnclaimedReservation(session);
		verify(service, never()).connect(session);
	}
}
