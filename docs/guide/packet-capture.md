# Packet capture

Open the **Assistant**, drop a saved PCAP or PCAPNG onto the chat, or use the **Attach packet capture** paperclip to choose a file. Hopline Terminal includes its Wireshark decoder and analyzes the file locally. This works without a terminal session, workstation capture drivers or a separate Wireshark installation.

The chat shows the frame count and observed signals as soon as the file opens. Choose **Analyze capture** or enter a question, such as “Which frame shows why DNS failed?” You can ask follow-up questions about the same attachment or choose **Inspect frames** to verify the answer. AI replies use the provider configured in Hopline Terminal. You can inspect the frames without connecting a provider. Dropping a new file starts a new capture conversation.

Try the two-frame DNS exercise with the assistant disconnected. [Sample capture and walkthrough](../examples/dns-failure/README.md)

## Open an appliance capture

| Appliance | How to get the saved trace into Hopline Terminal |
| --- | --- |
| F5 BIG-IP | Connect over SSH with an account that can read the PCAP over SFTP or SCP. Choose **SSH device**, select the BIG-IP session, enter the actual file path (for example, `/var/tmp/incident.pcap`) and click **Transfer and analyze**. Hopline Terminal downloads and checks the file, then opens the frames. [F5 capture and transfer example](https://my.f5.com/manage/s/article/K000141255) |
| Fortinet FortiGate | In FortiOS **Network › Diagnostics**, select the completed capture and click **Download** or **Save as .pcap**. Drop the file into the Hopline Terminal Assistant. This workflow uses the FortiGate GUI to export the PCAP. Direct retrieval from the FortiOS Diagnostics API is not implemented. [FortiGate packet capture guide](https://docs.fortinet.com/document/fortigate/7.4.7/administration-guide/462154) |

For files already on disk, chat accepts one uncompressed capture at a time, up to 64 MiB. Once the trace opens, select a frame or ask the assistant about the failure.

## Capture and transfer

Open **Session › Packet capture…** for SSH device transfers, device capture controls and the frame viewer.

| Source | Steps |
| --- | --- |
| IOS XE with file-based Embedded Packet Capture | Open an SSH session at the privileged EXEC prompt. Choose **SSH device › IOS XE capture**, enter the interface and direction, and optionally match a source or destination host. **Preview capture…** shows the exact commands. With changes allowed and the hostname confirmed, **Capture and transfer** sets up a temporary capture point on the device. It ends at 1,000 packets, after the chosen duration or when you stop it. Hopline Terminal removes the capture point and transfers the file using the session’s file service. |
| PCAP already on an SSH device | Choose **SSH device**, select the connected session and enter the remote capture path. On IOS XE choose **Existing device file**. **Transfer and analyze** fetches the file using SFTP or SCP and opens it as soon as the transfer completes. The first transfer asks for a local download folder. A completed capture in the Files transfer queue also has an **Analyze capture** action. |
| Local file | Choose **Capture file › Open capture…** and select an uncompressed PCAP or PCAPNG up to 64 MiB. |

IOS XE collection uses the device’s `monitor capture … file location flash:…` syntax and needs file-transfer access to flash. Hopline Terminal’s read-only mode and team command policy apply. For a device with a different capture CLI, record the trace in its terminal and use **Existing device file** or the SSH capture path field to fetch it. The original device file stays in place. If a link drops, the duration limit on the device still applies. The command preview and audit log identify the capture point and its file for recovery. [Cisco IOS XE packet capture guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-17/configuration_guide/nmgmt/b_1717_nmgmt_9500_cg/configuring_packet_capture.html)

## Inspect a failure

Enter a Wireshark display filter such as `dns.flags.rcode > 0` or `tcp.stream == 3` and click **Apply**. Protocol counts and signal counts reflect all matching frames. Expand **Busiest conversations by bytes** to see the TCP and UDP endpoints responsible for the most traffic. Click a stream to see its frames in both directions. Click a signal, such as **TCP reset** or **DNS error**, to narrow the view. Select a frame number and expand **Decoded header fields** for its protocol stack and available fields. Choose **Show full protocol details** to read the local Wireshark dissection, including fields such as DNS query names and answers. The packet list pages through 100 matches at a time. **Save capture as…** writes the original trace, including frames hidden by the filter.

For example, a DNS response with `dns.flags.rcode` equal to 3 is an NXDOMAIN response. Its source and frame number identify which observed server returned the error. A capture with only queries and no replies supports a different finding.

## Ask the assistant

Before collecting, enter the symptom in **Plan a capture with AI**. After collecting, select a frame and use **Ask about these frames**. The assistant receives the question, protocol and signal counts, selected frame metadata and a bounded sample of matching frames. You can apply a suggested Wireshark display filter and inspect the cited frames.

PCAP bytes, full protocol details and packet payloads stay local. Sampled metadata can include addresses, ports and timing. The configured provider, network identity masking and **What left this machine** logging apply to capture questions. Capture, transfer, filtering and header inspection also work with the assistant disconnected. [Privacy guide](privacy.md)
