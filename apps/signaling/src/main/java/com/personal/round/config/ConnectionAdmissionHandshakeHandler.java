package com.personal.round.config;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Accepted;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Admission;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Rejected;
import com.personal.round.signaling.SignalingService;
import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.security.core.Authentication;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeFailureException;
import org.springframework.web.socket.server.HandshakeHandler;

// AbstractHandshakeHandler.doHandshake는 final이라 상속으로 감쌀 수 없다. 연결 예약과 헤더 정제를
// 업그레이드 앞뒤에 넣기 위해 기본 핸드셰이크 처리기에 위임한다.
public final class ConnectionAdmissionHandshakeHandler implements HandshakeHandler {

	private final SignalingService signalingService;
	private final ConnectionAdmissionPolicy admissionPolicy;
	private final HandshakeHandler delegate;

	ConnectionAdmissionHandshakeHandler(
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy,
			HandshakeHandler delegate) {
		this.signalingService = signalingService;
		this.admissionPolicy = admissionPolicy;
		this.delegate = delegate;
	}

	@Override
	public boolean doHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes) {
		if (!signalingService.isRunning()) {
			response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
			return false;
		}
		if (!(request instanceof ServletServerHttpRequest servletRequest)) {
			throw new HandshakeFailureException("ServletServerHttpRequest required");
		}

		HttpServletRequest nativeRequest = servletRequest.getServletRequest();
		// BATON 모드의 방 일치는 보안 필터 체인의 인가 규칙이 이미 확인했다.
		ParticipationGrant participationGrant =
				nativeRequest.getUserPrincipal() instanceof Authentication authentication
								&& authentication.getPrincipal() instanceof ParticipationGrant grant
						? grant
						: null;
		Admission admission = admissionPolicy.reserve(
				nativeRequest.getRemoteAddr(),
				participationGrant);
		return switch (admission) {
			case Accepted accepted -> doAdmittedHandshake(
					nativeRequest,
					response,
					wsHandler,
					attributes,
					accepted.reservation(),
					participationGrant);
			case Rejected rejected -> {
				response.setStatusCode(switch (rejected.reason()) {
					case CLIENT_CAPACITY,
							PARTICIPATION_TOKEN_CAPACITY,
							PARTICIPANT_ROOM_CAPACITY -> HttpStatus.TOO_MANY_REQUESTS;
					case SERVER_CAPACITY -> HttpStatus.SERVICE_UNAVAILABLE;
				});
				yield false;
			}
		};
	}

	private boolean doAdmittedHandshake(
			HttpServletRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes,
			ConnectionAdmissionPolicy.Reservation reservation,
			ParticipationGrant participationGrant) {
		attributes.put(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		Principal principal = request.getUserPrincipal();
		if (participationGrant != null) {
			attributes.put(ParticipationGrant.SESSION_ATTRIBUTE, participationGrant);
			String subject = participationGrant.subject();
			principal = () -> subject;
		}
		boolean upgraded = false;
		try {
			upgraded = delegate.doHandshake(
					new ServletServerHttpRequest(new RedactedHandshakeRequest(request, principal)),
					response,
					wsHandler,
					attributes);
			return upgraded;
		}
		finally {
			if (!upgraded) {
				attributes.remove(
						ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE,
						reservation);
				reservation.close();
			}
		}
	}
}
