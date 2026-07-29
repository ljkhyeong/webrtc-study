package com.personal.round.config;

import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Accepted;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Admission;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Rejected;
import com.personal.round.signaling.ConnectionAdmissionPolicy.Rejection;
import com.personal.round.signaling.SignalingService;
import jakarta.servlet.ServletContext;
import java.util.Map;
import org.springframework.context.Lifecycle;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.context.ServletContextAware;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

public final class ConnectionAdmissionHandshakeHandler
		implements HandshakeHandler, Lifecycle, ServletContextAware {

	private final SignalingService signalingService;
	private final ConnectionAdmissionPolicy admissionPolicy;
	private final HandshakeHandler delegate;
	private volatile boolean running;

	public ConnectionAdmissionHandshakeHandler(
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy) {
		this(signalingService, admissionPolicy, new DefaultHandshakeHandler());
	}

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
		if (!signalingService.isAcceptingConnections()) {
			response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);
			return false;
		}

		Admission admission = admissionPolicy.reserve(request.getRemoteAddress());
		return switch (admission) {
			case Accepted accepted -> doAdmittedHandshake(
					request,
					response,
					wsHandler,
					attributes,
					accepted.reservation());
			case Rejected rejected -> {
				response.setStatusCode(rejected.reason() == Rejection.CLIENT_CAPACITY
						? HttpStatus.TOO_MANY_REQUESTS
						: HttpStatus.SERVICE_UNAVAILABLE);
				yield false;
			}
		};
	}

	private boolean doAdmittedHandshake(
			ServerHttpRequest request,
			ServerHttpResponse response,
			WebSocketHandler wsHandler,
			Map<String, Object> attributes,
			ConnectionAdmissionPolicy.Reservation reservation) {
		attributes.put(ConnectionAdmissionPolicy.RESERVATION_ATTRIBUTE, reservation);
		boolean upgraded = false;
		try {
			upgraded = delegate.doHandshake(request, response, wsHandler, attributes);
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
		if (delegate instanceof ServletContextAware contextAware) {
			contextAware.setServletContext(servletContext);
		}
	}

	@Override
	public void start() {
		if (delegate instanceof Lifecycle lifecycle) {
			lifecycle.start();
		}
		running = true;
	}

	@Override
	public void stop() {
		running = false;
		if (delegate instanceof Lifecycle lifecycle) {
			lifecycle.stop();
		}
	}

	@Override
	public boolean isRunning() {
		if (delegate instanceof Lifecycle lifecycle) {
			return lifecycle.isRunning();
		}
		return running;
	}
}
