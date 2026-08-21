package com.personal.round.config;

import com.personal.round.auth.ParticipationGrant;
import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Accepted;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Admission;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Rejected;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Rejection;
import com.personal.round.signaling.SignalingService;
import jakarta.servlet.ServletContext;
import java.security.Principal;
import java.util.Map;
import org.springframework.context.Lifecycle;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.context.ServletContextAware;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeFailureException;
import org.springframework.web.socket.server.HandshakeHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

public final class ConnectionAdmissionHandshakeHandler
		implements HandshakeHandler, Lifecycle, ServletContextAware {

	private final SignalingService signalingService;
	private final ConnectionAdmissionPolicy admissionPolicy;
	private final DefaultHandshakeHandler delegate;

	ConnectionAdmissionHandshakeHandler(
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy,
			DefaultHandshakeHandler delegate) {
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
		if (!signalingService.isAcceptingConnections()) {
			response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
			return false;
		}

		Object candidate = attributes.get(ParticipationGrant.SESSION_ATTRIBUTE);
		ParticipationGrant participationGrant =
				candidate instanceof ParticipationGrant grant ? grant : null;
		Admission admission = admissionPolicy.reserve(
				request.getRemoteAddress(),
				participationGrant);
		return switch (admission) {
			case Accepted accepted -> doAdmittedHandshake(
					request,
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
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes,
			ConnectionAdmissionPolicy.Reservation reservation,
			ParticipationGrant participationGrant) {
		attributes.put(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		boolean upgraded = false;
		try {
			if (!(request instanceof ServletServerHttpRequest servletRequest)) {
				throw new HandshakeFailureException("ServletServerHttpRequest required");
			}
			Principal principal = servletRequest.getPrincipal();
			if (participationGrant != null) {
				String subject = participationGrant.subject();
				principal = () -> subject;
			}
			ServerHttpRequest sanitizedRequest =
					new SensitiveHeaderRedactingServletServerHttpRequest(
							servletRequest,
							principal);
			upgraded = delegate.doHandshake(
					sanitizedRequest,
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

	@Override
	public void setServletContext(ServletContext servletContext) {
		delegate.setServletContext(servletContext);
	}

	@Override
	public void start() {
		delegate.start();
	}

	@Override
	public void stop() {
		delegate.stop();
	}

	@Override
	public boolean isRunning() {
		return delegate.isRunning();
	}
}
