package com.personal.round.auth;

import static com.personal.round.config.RoundRoutes.BATON_SIGNAL_SECURITY_PATTERN;
import static com.personal.round.config.RoundRoutes.BATON_TURN_CREDENTIALS_SECURITY_PATTERN;
import static com.personal.round.config.RoundRoutes.STANDALONE_SIGNAL;
import static com.personal.round.config.RoundRoutes.STANDALONE_TURN_CREDENTIALS;
import static org.springframework.security.config.Customizer.withDefaults;
import static org.springframework.security.config.http.SessionCreationPolicy.STATELESS;

import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import jakarta.servlet.DispatcherType;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtAudienceValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationEntryPoint;
import org.springframework.security.oauth2.server.resource.web.access.BearerTokenAccessDeniedHandler;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;

@Configuration(proxyBeanMethods = false)
public class RoundSecurityConfig {

	@Bean
	@Order(1)
	@ConditionalOnProperty(name = "round.auth.mode", havingValue = "baton")
	SecurityFilterChain batonProtectedEndpoints(
			HttpSecurity http,
			RoundAuthProperties properties)
			throws Exception {
		http.securityMatcher(
						BATON_SIGNAL_SECURITY_PATTERN,
						BATON_TURN_CREDENTIALS_SECURITY_PATTERN)
				.authorizeHttpRequests(authorize -> authorize.anyRequest().authenticated())
				.oauth2ResourceServer(oauth2 -> oauth2
						.bearerTokenResolver(new CookieBearerTokenResolver(properties.cookieName()))
						.jwt(withDefaults())
						.authenticationEntryPoint(noStoreBearerEntryPoint()))
				.exceptionHandling(exceptions -> exceptions
						.accessDeniedHandler(noStoreBearerAccessDeniedHandler()))
				.sessionManagement(session -> session.sessionCreationPolicy(STATELESS))
				.requestCache(cache -> cache.disable())
				.csrf(csrf -> csrf.ignoringRequestMatchers(
						BATON_TURN_CREDENTIALS_SECURITY_PATTERN))
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
						.requestMatchers(
								"/healthz",
								"/actuator/health/**",
								"/actuator/metrics/**",
								"/actuator/prometheus")
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
								STANDALONE_TURN_CREDENTIALS,
								"/healthz",
								"/actuator/health/**",
								"/actuator/metrics/**",
								"/actuator/prometheus")
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

	@Bean
	@ConditionalOnProperty(name = "round.auth.mode", havingValue = "baton")
	JwtDecoder batonJwtDecoder(RoundAuthProperties properties, Clock clock) {
		NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(properties.jwkSetUri())
				.jwsAlgorithm(SignatureAlgorithm.RS256)
				.jwtProcessorCustomizer(processor -> {
					JWSKeySelector<SecurityContext> keySelector =
							processor.getJWSKeySelector();
					processor.setJWSKeySelector(
							new BatonJwsKeySelector(keySelector));
				})
				.build();
		JwtTimestampValidator timestampValidator =
				new JwtTimestampValidator(Duration.ZERO);
		timestampValidator.setClock(clock);
		decoder.setJwtValidator(JwtValidators.createDefaultWithValidators(List.of(
				timestampValidator,
				new JwtIssuerValidator(properties.issuer()),
				new JwtAudienceValidator(properties.audience()),
				new BatonParticipationTokenValidator(
						properties.maxGrantLifetime(),
						clock))));
		return decoder;
	}

	private static AuthenticationEntryPoint noStoreBearerEntryPoint() {
		BearerTokenAuthenticationEntryPoint delegate =
				new BearerTokenAuthenticationEntryPoint();
		return (request, response, exception) -> {
			delegate.commence(request, response, exception);
			response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
		};
	}

	private static AccessDeniedHandler noStoreBearerAccessDeniedHandler() {
		BearerTokenAccessDeniedHandler delegate = new BearerTokenAccessDeniedHandler();
		return (request, response, exception) -> {
			delegate.handle(request, response, exception);
			response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
		};
	}
}
