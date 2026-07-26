package com.personal.round.config;

import com.personal.round.signaling.SignalingWebSocketHandler;
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

	public WebSocketConfig(
			SignalingWebSocketHandler handler,
			SignalingProperties properties) {
		properties.validate();
		this.handler = handler;
		this.originInterceptor = new OriginHandshakeInterceptor(
				new OriginPolicy(properties.getAllowedOrigins()));
	}

	@Override
	public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
		registry.addHandler(handler, "/signal")
				.addInterceptors(originInterceptor)
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
