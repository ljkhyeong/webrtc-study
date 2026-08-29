package com.personal.round.auth;

import static com.personal.round.config.RoundRoutes.BATON_SIGNAL_TEMPLATE;
import static com.personal.round.config.RoundRoutes.BATON_TURN_CREDENTIALS_TEMPLATE;
import static com.personal.round.config.RoundRoutes.STANDALONE_SIGNAL;
import static com.personal.round.config.RoundRoutes.STANDALONE_TURN_CREDENTIALS;
import static org.springframework.security.config.Customizer.withDefaults;
import static org.springframework.security.config.http.SessionCreationPolicy.STATELESS;

import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jose.util.health.HealthStatus;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.DispatcherType;
import java.net.MalformedURLException;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.actuate.endpoint.web.WebServerNamespace;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.micrometer.metrics.actuate.endpoint.MetricsEndpoint;
import org.springframework.boot.micrometer.metrics.autoconfigure.export.prometheus.PrometheusScrapeEndpoint;
import org.springframework.boot.security.autoconfigure.actuate.web.servlet.EndpointRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.config.ObjectPostProcessor;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtAudienceValidator;
import org.springframework.security.oauth2.jwt.JwtClaimNames;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationEntryPoint;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AuthenticationEntryPointFailureHandler;
import org.springframework.security.web.util.matcher.RequestMatcher;

@Configuration(proxyBeanMethods = false)
public class RoundSecurityConfig {
	private static final Duration JWK_CACHE_TTL = Duration.ofSeconds(60);
	private static final Duration JWK_REFRESH_MIN_INTERVAL = Duration.ofSeconds(30);

	@Bean
	@Order(1)
	@ConditionalOnProperty(name = "round.auth.mode", havingValue = "baton")
	SecurityFilterChain batonProtectedEndpoints(
			HttpSecurity http,
			RoundAuthProperties properties)
			throws Exception {
		AuthenticationEntryPoint authenticationEntryPoint =
				jwkAwareBearerEntryPoint();
		http.securityMatcher(
						BATON_SIGNAL_TEMPLATE,
						BATON_TURN_CREDENTIALS_TEMPLATE)
				.authorizeHttpRequests(authorize -> authorize.anyRequest().authenticated())
				.oauth2ResourceServer(oauth2 -> oauth2
						.bearerTokenResolver(new CookieBearerTokenResolver(properties.cookieName()))
						.jwt(withDefaults())
						.authenticationEntryPoint(authenticationEntryPoint)
						.withObjectPostProcessor(
								handleAuthenticationServiceFailures(
										authenticationEntryPoint)))
				.sessionManagement(session -> session.sessionCreationPolicy(STATELESS))
				.requestCache(cache -> cache.disable())
				.csrf(csrf -> csrf.ignoringRequestMatchers(
						BATON_TURN_CREDENTIALS_TEMPLATE))
				.logout(logout -> logout.disable());
		return http.build();
	}

	@Bean
	@Order(2)
	@ConditionalOnProperty(name = "round.auth.mode", havingValue = "baton")
	SecurityFilterChain batonPublicAndDeniedEndpoints(HttpSecurity http) throws Exception {
		http.authorizeHttpRequests(authorize -> authorize
						.dispatcherTypeMatchers(DispatcherType.ERROR)
						.permitAll()
						.requestMatchers(publicActuatorEndpointMatchers())
						.permitAll()
						.anyRequest()
						.denyAll())
				.sessionManagement(session -> session.sessionCreationPolicy(STATELESS))
				.requestCache(cache -> cache.disable())
				.logout(logout -> logout.disable());
		return http.build();
	}

	@Bean
	@ConditionalOnProperty(
			name = "round.auth.mode",
			havingValue = "standalone",
			matchIfMissing = true)
	SecurityFilterChain standaloneEndpoints(HttpSecurity http) throws Exception {
		http.authorizeHttpRequests(authorize -> authorize
						.dispatcherTypeMatchers(DispatcherType.ERROR)
						.permitAll()
						.requestMatchers(
								STANDALONE_SIGNAL,
								STANDALONE_TURN_CREDENTIALS)
						.permitAll()
						.requestMatchers(publicActuatorEndpointMatchers())
						.permitAll()
						.anyRequest()
						.denyAll())
				.sessionManagement(session -> session.sessionCreationPolicy(STATELESS))
				.requestCache(cache -> cache.disable())
				.csrf(csrf -> csrf.ignoringRequestMatchers(
						STANDALONE_TURN_CREDENTIALS))
				.logout(logout -> logout.disable());
		return http.build();
	}

	private static RequestMatcher[] publicActuatorEndpointMatchers() {
		return new RequestMatcher[] {
			EndpointRequest.to(
					HealthEndpoint.class,
					MetricsEndpoint.class,
					PrometheusScrapeEndpoint.class),
			EndpointRequest.toAdditionalPaths(
					WebServerNamespace.SERVER,
					HealthEndpoint.class)
		};
	}

	@Bean
	@ConditionalOnProperty(name = "round.auth.mode", havingValue = "baton")
	JwtDecoder batonJwtDecoder(
			RoundAuthProperties properties,
			Clock clock,
			MeterRegistry meterRegistry)
			throws MalformedURLException {
		AtomicReference<HealthStatus> lastJwkSourceHealth =
				new AtomicReference<>(HealthStatus.HEALTHY);
		Gauge.builder(
					"round.auth.jwk.source.healthy",
					lastJwkSourceHealth,
					health -> health.get() == HealthStatus.HEALTHY ? 1 : 0)
				.description("BATON JWK 원격 소스의 최근 상태입니다. 정상이면 1, 장애면 0입니다.")
				.register(meterRegistry);
		JWKSource<SecurityContext> jwkSource = buildJwkSource(
				JWKSourceBuilder.<SecurityContext>create(
						URI.create(properties.jwkSetUri()).toURL())
						.healthReporting(report -> lastJwkSourceHealth.set(
								report.getHealthStatus())));
		NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSource(jwkSource)
				.jwsAlgorithm(SignatureAlgorithm.RS256)
				.jwtProcessorCustomizer(processor -> {
					JWSKeySelector<SecurityContext> keySelector =
							processor.getJWSKeySelector();
					processor.setJWSKeySelector(
							new BatonJwsKeySelector(
									keySelector,
									() -> lastJwkSourceHealth.get()
											== HealthStatus.NOT_HEALTHY));
				})
				.build();
		JwtTimestampValidator timestampValidator =
				new JwtTimestampValidator(Duration.ZERO);
		timestampValidator.setClock(clock);
		decoder.setJwtValidator(JwtValidators.createDefaultWithValidators(List.of(
				timestampValidator,
				new JwtIssuerValidator(properties.issuer()),
				new JwtAudienceValidator(properties.audience()),
				new JwtClaimValidator<Collection<String>>(
						JwtClaimNames.AUD,
						audiences -> audiences != null
								&& audiences.size() == 1),
				new BatonParticipationTokenValidator(
						properties.maxGrantLifetime(),
						clock))));
		return decoder;
	}

	static JWKSource<SecurityContext> buildJwkSource(
			JWKSourceBuilder<SecurityContext> sourceBuilder) {
		return sourceBuilder
				.cache(
						JWK_CACHE_TTL.toMillis(),
						JWKSourceBuilder.DEFAULT_CACHE_REFRESH_TIMEOUT)
				.refreshAheadCache(false)
				.rateLimited(JWK_REFRESH_MIN_INTERVAL.toMillis())
				.build();
	}

	static AuthenticationEntryPoint jwkAwareBearerEntryPoint() {
		BearerTokenAuthenticationEntryPoint delegate =
				new BearerTokenAuthenticationEntryPoint();
		return (request, response, exception) -> {
			if (exception instanceof AuthenticationServiceException) {
				response.setStatus(HttpStatus.SERVICE_UNAVAILABLE.value());
				response.setContentLength(0);
				return;
			}
			delegate.commence(request, response, exception);
		};
	}

	private static ObjectPostProcessor<BearerTokenAuthenticationFilter>
			handleAuthenticationServiceFailures(
					AuthenticationEntryPoint authenticationEntryPoint) {
		return new ObjectPostProcessor<>() {
			@Override
			public <O extends BearerTokenAuthenticationFilter> O postProcess(O filter) {
				AuthenticationEntryPointFailureHandler failureHandler =
						new AuthenticationEntryPointFailureHandler(
								authenticationEntryPoint);
				failureHandler.setRethrowAuthenticationServiceException(false);
				filter.setAuthenticationFailureHandler(failureHandler);
				return filter;
			}
		};
	}
}
