package com.personal.round.config;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class SignalingExecutionConfig {

	public static final String OUTBOUND_EXECUTOR_BEAN = "signalingOutboundExecutor";

	@Bean(name = OUTBOUND_EXECUTOR_BEAN, destroyMethod = "shutdownNow")
	ExecutorService signalingOutboundExecutor() {
		return Executors.newThreadPerTaskExecutor(
				Thread.ofVirtual()
						.name("round-signaling-outbound-", 0)
						.factory());
	}
}
