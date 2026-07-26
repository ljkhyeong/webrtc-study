package com.personal.round.signaling;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class HeartbeatScheduler {

	private final SignalingService signalingService;

	public HeartbeatScheduler(SignalingService signalingService) {
		this.signalingService = signalingService;
	}

	@Scheduled(fixedDelayString = "${round.signaling.heartbeat-interval-ms:30000}")
	public void sweep() {
		signalingService.heartbeatSweep();
	}
}
