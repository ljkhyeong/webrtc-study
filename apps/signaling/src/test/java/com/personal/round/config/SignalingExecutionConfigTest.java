package com.personal.round.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

class SignalingExecutionConfigTest {

	@Test
	void contextOwnsTheDedicatedVirtualThreadExecutor() throws Exception {
		ExecutorService executor;
		try (AnnotationConfigApplicationContext context =
				new AnnotationConfigApplicationContext(SignalingExecutionConfig.class)) {
			executor = context.getBean(
					SignalingExecutionConfig.OUTBOUND_EXECUTOR_BEAN,
					ExecutorService.class);

			ThreadSnapshot thread = executor.submit(() -> new ThreadSnapshot(
					Thread.currentThread().getName(),
					Thread.currentThread().isVirtual()))
					.get(1, TimeUnit.SECONDS);

			assertThat(thread.name()).startsWith("round-signaling-outbound-");
			assertThat(thread.virtual()).isTrue();
			assertThat(executor.isShutdown()).isFalse();
		}

		assertThat(executor.isShutdown()).isTrue();
		assertThat(executor.awaitTermination(1, TimeUnit.SECONDS)).isTrue();
	}

	private record ThreadSnapshot(String name, boolean virtual) {
	}
}
