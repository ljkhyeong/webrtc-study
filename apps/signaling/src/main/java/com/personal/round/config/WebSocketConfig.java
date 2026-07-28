package com.personal.round.config;

import com.personal.round.signaling.ConnectionAdmissionPolicy;
import com.personal.round.signaling.SignalingService;
import com.personal.round.signaling.SignalingWebSocketHandler;
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
	private final ConnectionAdmissionHandshakeHandler admissionHandler;

	public WebSocketConfig(
			SignalingWebSocketHandler handler,
			SignalingService signalingService,
			ConnectionAdmissionPolicy admissionPolicy,
			SignalingProperties properties,
			Environment environment) {
		this.handler = handler;
		boolean production = environment.acceptsProfiles(Profiles.of("production"));
		this.originInterceptor = new OriginHandshakeInterceptor(
				new OriginPolicy(properties.allowedOrigins(), production));
		this.admissionInterceptor =
				new ConnectionAdmissionHandshakeInterceptor(signalingService);
		this.admissionHandler =
				new ConnectionAdmissionHandshakeHandler(signalingService, admissionPolicy);
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		registry.addHandler(handler, "/signal")
				.addInterceptors(originInterceptor, admissionInterceptor)
				.setHandshakeHandler(admissionHandler)
				.setAllowedOriginPatterns("*");
	}

	@Bean
	ServletServerContainerFactoryBean webSocketContainer(SignalingProperties properties) {
		ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
		container.setMaxTextMessageBufferSize(properties.maxTextPayloadBytes());
		container.setMaxBinaryMessageBufferSize(properties.maxTextPayloadBytes());
		return container;
	}
}
