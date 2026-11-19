import { createHash } from "crypto";

/**
 * C# compiled by the PowerShell init script (pwsh 7.2+, with Add-Type) into a
 * DLL cached under the data dir: a client for the daemon's socket, and the
 * PSReadLine predictor that fills the suggestion list from it.
 *
 * It is pasted into a single-quoted here-string of a script that must stay
 * ASCII and load in Windows PowerShell 5.1, which never compiles it: ASCII
 * only, and no line may start with '@. The language level must compile under
 * every pwsh from 7.2 on: no file-scoped namespaces, no `using var`.
 */
export const HELPER_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management.Automation.Subsystem;
using System.Management.Automation.Subsystem.Prediction;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public static class ShellwiseClient
{
    // One request to the daemon: the lines of its reply (without the blank
    // terminator line), or null on any failure, including the deadline.
    public static string[] Request(string socketPath, string message, int timeoutMs)
    {
        try
        {
            Stopwatch watch = Stopwatch.StartNew();
            using (Socket s = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified))
            {
                s.SendTimeout = timeoutMs;
                s.ReceiveTimeout = timeoutMs;
                s.Connect(new UnixDomainSocketEndPoint(socketPath));
                s.Send(Encoding.UTF8.GetBytes(message));
                MemoryStream data = new MemoryStream();
                byte[] buf = new byte[4096];
                while (true)
                {
                    // One deadline for the whole reply, not per read. A
                    // timeout of 0 would mean "wait forever".
                    int left = timeoutMs - (int)watch.ElapsedMilliseconds;
                    if (left <= 0) return null;
                    s.ReceiveTimeout = left;
                    int n = s.Receive(buf);
                    if (n <= 0) return null;
                    data.Write(buf, 0, n);
                    // Decoded whole each time: a chunk can end inside a character.
                    string text = Encoding.UTF8.GetString(data.GetBuffer(), 0, (int)data.Length);
                    int end = text.IndexOf("\n\n", StringComparison.Ordinal);
                    if (end == 0) return new string[0];
                    if (end > 0) return text.Substring(0, end).Split('\n');
                }
            }
        }
        catch
        {
            return null;
        }
    }

    // Stores a command through the daemon; false when it did not answer OK.
    public static bool Add(string socketPath, string command, string cwd, int exitCode, int durationMs, string session, string shell)
    {
        string message = "ADD\t" + Field(command) + "\t" + Field(cwd)
            + "\t" + exitCode.ToString(CultureInfo.InvariantCulture)
            + "\t" + durationMs.ToString(CultureInfo.InvariantCulture)
            + "\t" + Field(session) + "\t" + Field(shell) + "\n";
        string[] reply = Request(socketPath, message, 200);
        return reply != null && reply.Length > 0 && reply[0] == "OK";
    }

    // The protocol is one tab-separated line: a tab or line break inside a
    // value would split it. Spaces, as the CLI does for the command.
    private static string Field(string value)
    {
        if (value == null) return "";
        return value.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    }
}

public class ShellwisePredictor : ICommandPredictor
{
    public static string SocketPath = "";

    // PSReadLine waits about 20 ms for all predictors together.
    private const int TimeoutMs = 15;

    public Guid Id { get { return new Guid("6f1c2a3e-8a57-4d0b-9c55-5e2f1c0d7a11"); } }
    public string Name { get { return "shellwise"; } }
    public string Description { get { return "Suggestions from shellwise history"; } }

    public SuggestionPackage GetSuggestion(PredictionClient client, PredictionContext context, CancellationToken cancellationToken)
    {
        // Never throw into PSReadLine: any failure means no suggestions.
        try
        {
            string input = context.InputAst.Extent.Text;
            if (input.Length < 2 || input.IndexOf('\n') >= 0 || input.IndexOf('\r') >= 0)
            {
                return default(SuggestionPackage);
            }
            string[] lines = ShellwiseClient.Request(SocketPath, "SUGGEST\t" + input.Replace('\t', ' ') + "\t5\tv2\n", TimeoutMs);
            if (lines == null) return default(SuggestionPackage);
            List<PredictiveSuggestion> list = new List<PredictiveSuggestion>();
            foreach (string line in lines)
            {
                // <source>\t<command>; the source becomes the tooltip.
                int tab = line.IndexOf('\t');
                if (tab < 0) continue;
                string text = line.Substring(tab + 1);
                if (text.Length == 0 || text == input) continue;
                list.Add(new PredictiveSuggestion(text, line.Substring(0, tab)));
            }
            return list.Count > 0 ? new SuggestionPackage(list) : default(SuggestionPackage);
        }
        catch
        {
            return default(SuggestionPackage);
        }
    }

    public bool CanAcceptFeedback(PredictionClient client, PredictorFeedbackKind feedback) { return false; }
    public void OnSuggestionDisplayed(PredictionClient client, uint session, int countOrIndex) { }
    public void OnSuggestionAccepted(PredictionClient client, uint session, string acceptedSuggestion) { }
    public void OnCommandLineAccepted(PredictionClient client, IReadOnlyList<string> history) { }
    public void OnCommandLineExecuted(PredictionClient client, string commandLine, bool success) { }
}
`;

/** Names the cached DLL: a changed source never loads an old build. */
export const HELPER_HASH = createHash("sha256").update(HELPER_SOURCE).digest("hex").slice(0, 12);
