package com.personal.round.health;

import com.personal.round.signaling.SignalingService;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.stereotype.Component;

@Component("signaling")
public class SignalingHealthIndicator implements HealthIndicator {

	private final SignalingService signalingService;

	public SignalingHealthIndicator(SignalingService signalingService) {
		this.signalingService = signalingService;
	}

	@Override
	public Health health() {
		if (signalingService.isAcceptingConnections()) {
			return Health.up().build();
		}
		return Health.outOfService().build();
	}
}
