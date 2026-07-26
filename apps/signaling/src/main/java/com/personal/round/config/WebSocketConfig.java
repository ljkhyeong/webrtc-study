package com.personal.round.config;

import com.personal.round.signaling.SignalingWebSocketHandler;
import com.personal.round.signaling.SignalingService;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

	private final SignalingWebSocketHandler handler;
	private final OriginHandshakeInterceptor originInterceptor;
	private final ConnectionAdmissionHandshakeInterceptor admissionInterceptor;

	public WebSocketConfig(
			SignalingWebSocketHandler handler,
			SignalingService signalingService,
			SignalingProperties properties,
			Environment environment) {
		properties.validate();
		this.handler = handler;
		boolean production = environment.acceptsProfiles(Profiles.of("production"));
		this.originInterceptor = new OriginHandshakeInterceptor(
				new OriginPolicy(properties.getAllowedOrigins(), production));
		this.admissionInterceptor =
				new ConnectionAdmissionHandshakeInterceptor(signalingService);
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		registry.addHandler(handler, "/signal")
				.addInterceptors(admissionInterceptor, originInterceptor)
				.setAllowedOriginPatterns("*");
	}

	@Bean
	ServletServerContainerFactoryBean webSocketContainer(SignalingProperties properties) {
		ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
		container.setMaxTextMessageBufferSize(properties.getMaxTextPayloadBytes());
		container.setMaxBinaryMessageBufferSize(properties.getMaxTextPayloadBytes());
		return container;
	}
}
