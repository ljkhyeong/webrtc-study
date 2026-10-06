package com.personal.round.net;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ClientAddressKeyResolverTest {

	@Test
	void keepsTheFullCanonicalIpv4Address() {
		assertThat(ClientAddressKeyResolver.resolve("192.000.002.010")).isEqualTo("ipv4:192.0.2.10");
		assertThat(ClientAddressKeyResolver.resolve("192.0.2.11")).isNotEqualTo("ipv4:192.0.2.10");
	}

	@Test
	void groupsIpv6AddressesByTheirFirstSixtyFourBits() {
		String first = ClientAddressKeyResolver.resolve("2001:db8:abcd:12::1");
		String rotatedInterfaceId = ClientAddressKeyResolver.resolve("[2001:0db8:abcd:0012:ffff::beef]");
		String otherPrefix = ClientAddressKeyResolver.resolve("2001:db8:abcd:13::1");

		assertThat(first)
				.isEqualTo(rotatedInterfaceId)
				.endsWith("/64");
		assertThat(otherPrefix).isNotEqualTo(first);
	}

	@Test
	void ignoresIpv6ZoneIdentifiersAndFailsClosedForNonNumericValues() {
		assertThat(ClientAddressKeyResolver.resolve("fe80::1%en0")).isEqualTo(ClientAddressKeyResolver.resolve("fe80::beef%4"));
		assertThat(ClientAddressKeyResolver.resolve("study.example")).isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
		assertThat(ClientAddressKeyResolver.resolve("999.0.0.1")).isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
		assertThat(ClientAddressKeyResolver.resolve(null)).isEqualTo(ClientAddressKeyResolver.UNKNOWN_CLIENT);
	}
}
