package com.personal.round.net;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetSocketAddress;
import org.junit.jupiter.api.Test;

class ClientAddressKeyResolverTest {

	private final ClientAddressKeyResolver resolver = new ClientAddressKeyResolver();

	@Test
	void keepsTheFullCanonicalIpv4Address() {
		assertThat(resolver.resolve("192.000.002.010"))
				.isEqualTo(resolver.resolve(new InetSocketAddress("192.0.2.10", 41_000)))
				.isEqualTo("ipv4:192.0.2.10");
		assertThat(resolver.resolve("192.0.2.11")).isNotEqualTo("ipv4:192.0.2.10");
	}

	@Test
	void groupsIpv6AddressesByTheirFirstSixtyFourBits() {
		String first = resolver.resolve("2001:db8:abcd:12::1");
		String rotatedInterfaceId = resolver.resolve("[2001:0db8:abcd:0012:ffff::beef]");
		String otherPrefix = resolver.resolve("2001:db8:abcd:13::1");

		assertThat(first)
				.isEqualTo(rotatedInterfaceId)
				.endsWith("/64");
		assertThat(otherPrefix).isNotEqualTo(first);
	}

	@Test
	void ignoresIpv6ZoneIdentifiersAndFailsClosedForNonNumericValues() {
		assertThat(resolver.resolve("fe80::1%en0")).isEqualTo(resolver.resolve("fe80::beef%4"));
		assertThat(resolver.resolve("study.example")).isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
		assertThat(resolver.resolve("999.0.0.1")).isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
		assertThat(resolver.resolve((String) null))
				.isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
		assertThat(resolver.resolve((InetSocketAddress) null))
				.isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
	}
}
