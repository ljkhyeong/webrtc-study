package com.personal.round.signaling;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class UnjoinedSessionScheduler {

	private final SignalingService signalingService;

	public UnjoinedSessionScheduler(SignalingService signalingService) {
		this.signalingService = signalingService;
	}

	@Scheduled(fixedDelayString = "${round.signaling.unjoined-sweep-interval-ms:1000}")
	public void sweep() {
		signalingService.expireUnjoinedSessions();
	}
}
