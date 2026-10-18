// AgentShield Windows app (AgentShieldHelper.exe), installed by AgentShield-System-Setup.exe.
//
// Connects this PC to an AgentShield account ONCE, then hands each browser on the PC its own single-use
// activation code, so every browser (Chrome, Edge, Brave...) connects without the person pasting anything.
//
// How it stays safe:
//  * Connecting needs a single-use activation code the person generated while signed in to the portal.
//  * The PC's identity is an ECDSA P-256 key created in the Windows user's key store and marked
//    non-exportable. To get a browser code the app signs a fresh server challenge with it
//    (backend/app/api/computers.py). Nothing secret is written to disk: pc-connection.json holds only
//    the server address, the PC id and the account email.
//  * Each browser still creates its own key and activates through /api/v1/device/activate; the server
//    checks every browser and every request. Removing the PC in the portal signs out all its browsers.
//  * The extension only asks; it never receives the PC key.
//
// Modes (one exe):
//   chrome-extension://<id>/      Native messaging host (started by Chrome/Edge/Brave): GET_CODE, STATUS
//   agentshield://connect?code=…  Link from the portal's "Connect this PC" button (asks before connecting)
//   --connect-ui                  Window to paste a code (end of setup, Start menu "Connect AgentShield")
//   --connect <code>              Connect without a window (silent setup /CODE=); exit code 0 = connected
//   --status                      Prints the connection as JSON
//   --disconnect                  Disconnects this PC (also run on uninstall)
//
// Build: scripts\helper\build-helper.ps1 (uses the C# compiler that ships with Windows / .NET Framework 4).
// This file must stay C# 5 (no string interpolation, no ?. operators).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("AgentShield")]
[assembly: AssemblyProduct("AgentShield")]
[assembly: AssemblyCompany("AgentShield")]
[assembly: AssemblyDescription("AgentShield Windows app: connects this PC's browsers")]
[assembly: AssemblyVersion("2.4.0.0")]
[assembly: AssemblyFileVersion("2.4.0.0")]

namespace AgentShield
{
    internal sealed class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code, string message) : base(message) { Code = code; }
    }

    internal sealed class Connection
    {
        public string ApiUrl;
        public string ComputerId;
        public string Email;
        public string OrganizationName;
        public string KeyName;
        public string ConnectedAt;
    }

    internal static class Program
    {
        private const string ActivationPrefix = "ASA1.";
        // SubjectPublicKeyInfo header for an uncompressed P-256 point (followed by 0x04 || X || Y)
        private static readonly byte[] SpkiP256Prefix = HexToBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200");
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
            }
            catch { }

            string first = args.Length > 0 ? args[0] : "";
            try
            {
                if (first.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase))
                    return NativeMessaging.Run();
                if (first.StartsWith("agentshield:", StringComparison.OrdinalIgnoreCase))
                    return ConnectFromLink(first);
                if (first == "--connect" && args.Length > 1)
                    return ConnectSilently(args[1]);
                if (first == "--status")
                    return PrintStatus();
                if (first == "--disconnect")
                {
                    Disconnect(true);
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.Run(new ConnectForm(null));
                return 0;
            }
            catch (Exception e)
            {
                Log("Unexpected error: " + e);
                return 2;
            }
        }

        // ------------------------------------------------------------------ settings and storage

        internal static string DataDir
        {
            get
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentShield");
                Directory.CreateDirectory(dir);
                return dir;
            }
        }

        private static string ConnectionFile { get { return Path.Combine(DataDir, "pc-connection.json"); } }

        internal static void Log(string message)
        {
            try
            {
                string file = Path.Combine(DataDir, "app.log");
                if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024) File.Delete(file);
                File.AppendAllText(file, DateTime.UtcNow.ToString("u") + "  " + message + Environment.NewLine);
            }
            catch { }
        }

        /// <summary>Server and portal address written by the installer (HKLM\SOFTWARE\AgentShield).</summary>
        internal static string MachineSetting(string name)
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = baseKey.OpenSubKey(@"SOFTWARE\AgentShield"))
                {
                    if (key == null) return "";
                    object value = key.GetValue(name);
                    return value == null ? "" : value.ToString().Trim().TrimEnd('/');
                }
            }
            catch
            {
                return "";
            }
        }

        internal static Connection LoadConnection()
        {
            try
            {
                if (!File.Exists(ConnectionFile)) return null;
                Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ConnectionFile));
                Connection c = new Connection();
                c.ApiUrl = Str(d, "apiUrl");
                c.ComputerId = Str(d, "computerId");
                c.Email = Str(d, "email");
                c.OrganizationName = Str(d, "organizationName");
                c.KeyName = Str(d, "keyName");
                c.ConnectedAt = Str(d, "connectedAt");
                if (c.ApiUrl == "" || c.ComputerId == "" || c.KeyName == "" || !CngKey.Exists(c.KeyName)) return null;
                return c;
            }
            catch
            {
                return null;
            }
        }

        private static void SaveConnection(Connection c)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["apiUrl"] = c.ApiUrl;
            d["computerId"] = c.ComputerId;
            d["email"] = c.Email;
            d["organizationName"] = c.OrganizationName;
            d["keyName"] = c.KeyName;
            d["connectedAt"] = c.ConnectedAt;
            File.WriteAllText(ConnectionFile, Json.Serialize(d));
        }

        private static void ForgetConnection(Connection c)
        {
            try { if (File.Exists(ConnectionFile)) File.Delete(ConnectionFile); } catch { }
            if (c != null && !string.IsNullOrEmpty(c.KeyName))
            {
                try
                {
                    if (CngKey.Exists(c.KeyName)) CngKey.Open(c.KeyName).Delete();
                }
                catch { }
            }
        }

        // ------------------------------------------------------------------ activation codes

        /// <summary>Decodes "ASA1." + base64url(JSON {u: server, t: token}), tolerating copy/paste noise.</summary>
        internal static bool TryParseCode(string code, out string apiUrl, out string token)
        {
            apiUrl = "";
            token = "";
            try
            {
                StringBuilder sb = new StringBuilder();
                foreach (char ch in code ?? "")
                    if (!char.IsWhiteSpace(ch)) sb.Append(ch);
                string trimmed = sb.ToString().Trim('"', '\'', '`', ',');
                if (!trimmed.StartsWith(ActivationPrefix)) return false;
                string b64 = trimmed.Substring(ActivationPrefix.Length).Replace('-', '+').Replace('_', '/');
                b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
                Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
                apiUrl = Str(d, "u").Trim().TrimEnd('/');
                token = Str(d, "t").Trim();
                return (apiUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                        apiUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) && token.StartsWith("asa_");
            }
            catch
            {
                return false;
            }
        }

        internal static string MakeCode(string apiUrl, string token)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["u"] = apiUrl;
            d["t"] = token;
            string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Json.Serialize(d)));
            return ActivationPrefix + b64.Replace('+', '-').Replace('/', '_').TrimEnd('=');
        }

        // ------------------------------------------------------------------ PC key (non-exportable)

        private static CngKey CreateKey(string name)
        {
            CngKeyCreationParameters p = new CngKeyCreationParameters();
            p.ExportPolicy = CngExportPolicies.None;          // the private key never leaves the key store
            p.KeyUsage = CngKeyUsages.Signing;
            p.Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider;
            p.KeyCreationOptions = CngKeyCreationOptions.None; // this Windows user only
            return CngKey.Create(CngAlgorithm.ECDsaP256, name, p);
        }

        private static string PublicKeySpki(CngKey key)
        {
            // ECCPUBLICBLOB: magic (4) + key length (4) + X (32) + Y (32)
            byte[] blob = key.Export(CngKeyBlobFormat.EccPublicBlob);
            byte[] spki = new byte[SpkiP256Prefix.Length + 1 + 64];
            Buffer.BlockCopy(SpkiP256Prefix, 0, spki, 0, SpkiP256Prefix.Length);
            spki[SpkiP256Prefix.Length] = 0x04;
            Buffer.BlockCopy(blob, 8, spki, SpkiP256Prefix.Length + 1, 64);
            return Convert.ToBase64String(spki);
        }

        private static string Sign(string keyName, string message)
        {
            using (CngKey key = CngKey.Open(keyName))
            using (ECDsaCng ecdsa = new ECDsaCng(key))
            {
                ecdsa.HashAlgorithm = CngAlgorithm.Sha256;
                // IEEE P1363 r||s (64 bytes), the same format WebCrypto uses
                return Convert.ToBase64String(ecdsa.SignData(Encoding.UTF8.GetBytes(message)));
            }
        }

        // ------------------------------------------------------------------ HTTP

        private static Dictionary<string, object> Post(string url, Dictionary<string, object> body)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 20000;
            req.UserAgent = "AgentShieldHelper/2.4";
            byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(body));
            try
            {
                using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string text = r.ReadToEnd();
                    return text.Trim() == "" ? new Dictionary<string, object>() : Json.Deserialize<Dictionary<string, object>>(text);
                }
            }
            catch (WebException e)
            {
                HttpWebResponse res = e.Response as HttpWebResponse;
                if (res == null) throw new HelperException("NETWORK", "Cannot reach the AgentShield server (" + e.Message + "). Check the internet connection and try again.");
                string code = "HTTP_" + (int)res.StatusCode;
                string message = "The AgentShield server refused the request (HTTP " + (int)res.StatusCode + ").";
                try
                {
                    using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        Dictionary<string, object> err = Json.Deserialize<Dictionary<string, object>>(r.ReadToEnd());
                        object detail;
                        if (err != null && err.TryGetValue("detail", out detail))
                        {
                            Dictionary<string, object> dd = detail as Dictionary<string, object>;
                            if (dd != null)
                            {
                                if (Str(dd, "code") != "") code = Str(dd, "code");
                                if (Str(dd, "message") != "") message = Str(dd, "message");
                            }
                            else if (detail is string)
                            {
                                message = (string)detail;
                            }
                        }
                    }
                }
                catch { }
                throw new HelperException(code, message);
            }
        }

        private static Dictionary<string, object> SignedPost(Connection c, string path, string browser)
        {
            Dictionary<string, object> ch = new Dictionary<string, object>();
            ch["computer_id"] = c.ComputerId;
            string nonce = Str(Post(c.ApiUrl + "/api/v1/computer/challenge", ch), "nonce");
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["computer_id"] = c.ComputerId;
            body["nonce"] = nonce;
            body["signature"] = Sign(c.KeyName, nonce);
            if (!string.IsNullOrEmpty(browser)) body["browser"] = browser.Length > 120 ? browser.Substring(0, 120) : browser;
            return Post(c.ApiUrl + path, body);
        }

        private static bool ForgetsPc(string code)
        {
            return code == "REVOKED" || code == "DEVICE_UNKNOWN" || code == "ACCOUNT_DISABLED" || code == "INVALID_SIGNATURE";
        }

        // ------------------------------------------------------------------ operations

        /// <summary>Connects this PC with a portal activation code. Returns the account email.</summary>
        internal static Connection Connect(string code)
        {
            string apiUrl, token;
            if (!TryParseCode(code, out apiUrl, out token))
                throw new HelperException("INVALID_CODE", "That is not a valid activation code. Copy the full code (it starts with ASA1.) from the AgentShield portal.");
            string locked = MachineSetting("ServerUrl");
            if (locked != "" && !string.Equals(locked, apiUrl, StringComparison.OrdinalIgnoreCase))
                throw new HelperException("WRONG_SERVER", "This code is for a different AgentShield server than the one this PC was set up for (" + locked + ").");

            Disconnect(false);
            string keyName = "AgentShield-PC-" + Guid.NewGuid().ToString("N");
            string publicKey;
            using (CngKey key = CreateKey(keyName)) publicKey = PublicKeySpki(key);

            Dictionary<string, object> body = new Dictionary<string, object>();
            body["activation_token"] = token;
            body["public_key"] = publicKey;
            body["name"] = Environment.MachineName;
            body["platform"] = WindowsName();
            Dictionary<string, object> res;
            try
            {
                res = Post(apiUrl + "/api/v1/computer/activate", body);
            }
            catch
            {
                try { CngKey.Open(keyName).Delete(); } catch { }
                throw;
            }
            Connection c = new Connection();
            c.ApiUrl = apiUrl;
            c.ComputerId = Str(res, "computer_id");
            c.Email = Str(res, "user_email");
            c.OrganizationName = Str(res, "organization_name");
            c.KeyName = keyName;
            c.ConnectedAt = DateTime.UtcNow.ToString("o");
            SaveConnection(c);
            Log("Connected this PC to " + c.Email + " at " + apiUrl);
            return c;
        }

        /// <summary>Removes the connection (and tells the server when it can be reached).</summary>
        internal static void Disconnect(bool tellServer)
        {
            Connection c = LoadConnection();
            if (c == null)
            {
                ForgetConnection(null);
                return;
            }
            if (tellServer)
            {
                try { SignedPost(c, "/api/v1/computer/deactivate", null); }
                catch (Exception e) { Log("Disconnect: server not told (" + e.Message + ")"); }
            }
            ForgetConnection(c);
            Log("Disconnected this PC");
        }

        /// <summary>A fresh single-use activation code for one browser on this PC.</summary>
        internal static string BrowserCode(string browser)
        {
            Connection c = LoadConnection();
            if (c == null) throw new HelperException("NOT_CONNECTED", "This PC is not connected yet. Open \"Connect AgentShield\" from the Start menu.");
            try
            {
                Dictionary<string, object> res = SignedPost(c, "/api/v1/computer/browser-code", browser);
                return MakeCode(c.ApiUrl, Str(res, "token"));
            }
            catch (HelperException e)
            {
                if (ForgetsPc(e.Code))
                {
                    ForgetConnection(c);
                    Log("PC connection removed by the server (" + e.Code + ")");
                }
                throw;
            }
        }

        private static int ConnectSilently(string code)
        {
            try
            {
                Connection c = Connect(code);
                Console.Out.WriteLine("Connected to " + c.Email);
                return 0;
            }
            catch (HelperException e)
            {
                Log("Silent connect failed: " + e.Code + " " + e.Message);
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }

        private static int PrintStatus()
        {
            Connection c = LoadConnection();
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["connected"] = c != null;
            if (c != null)
            {
                d["email"] = c.Email;
                d["organization"] = c.OrganizationName;
                d["server"] = c.ApiUrl;
                d["computerId"] = c.ComputerId;
            }
            Console.Out.WriteLine(Json.Serialize(d));
            return c != null ? 0 : 1;
        }

        /// <summary>agentshield://connect?code=ASA1.… from the portal's "Connect this PC" button.</summary>
        private static int ConnectFromLink(string link)
        {
            Application.EnableVisualStyles();
            string code = "";
            int q = link.IndexOf('?');
            if (q >= 0)
            {
                foreach (string part in link.Substring(q + 1).Split('&'))
                {
                    if (part.StartsWith("code=", StringComparison.OrdinalIgnoreCase))
                        code = Uri.UnescapeDataString(part.Substring(5).Replace('+', ' '));
                }
            }
            string apiUrl, token;
            if (!TryParseCode(code, out apiUrl, out token))
            {
                MessageBox.Show("This link does not contain a valid AgentShield code. Generate a new one in the portal.",
                    "AgentShield", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
            Application.Run(new ConnectForm(code));
            return 0;
        }

        // ------------------------------------------------------------------ small utilities

        /// <summary>"Windows 11" / "Windows 10" (Environment.OSVersion reports 6.2 to apps without a manifest).</summary>
        private static string WindowsName()
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    int build;
                    if (key != null && int.TryParse(Convert.ToString(key.GetValue("CurrentBuildNumber")), out build))
                        return build >= 22000 ? "Windows 11" : build >= 10240 ? "Windows 10" : "Windows";
                }
            }
            catch { }
            return "Windows";
        }

        internal static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
        }

        private static byte[] HexToBytes(string hex)
        {
            byte[] b = new byte[hex.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return b;
        }

        internal static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        internal static string PortalUrl()
        {
            string dashboard = MachineSetting("DashboardUrl");
            return dashboard != "" ? dashboard + "/#signin" : "";
        }
    }

    /// <summary>Chrome / Edge / Brave native messaging: one length-prefixed JSON message in, one out.</summary>
    internal static class NativeMessaging
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static int Run()
        {
            Stream stdin = Console.OpenStandardInput();
            Stream stdout = Console.OpenStandardOutput();
            Dictionary<string, object> request = Read(stdin);
            Dictionary<string, object> reply = new Dictionary<string, object>();
            string type = request == null ? "" : Program.Str(request, "type");
            try
            {
                if (type == "GET_CODE")
                {
                    reply["ok"] = true;
                    reply["code"] = Program.BrowserCode(Program.Str(request, "browser"));
                }
                else if (type == "STATUS")
                {
                    Connection c = Program.LoadConnection();
                    reply["ok"] = true;
                    reply["connected"] = c != null;
                    if (c != null)
                    {
                        reply["email"] = c.Email;
                        reply["organization"] = c.OrganizationName;
                        reply["server"] = c.ApiUrl;
                    }
                    reply["portal"] = Program.PortalUrl();
                }
                else if (type == "OPEN_CONNECT")
                {
                    // The popup's "Connect this PC" button: open the app's connect window
                    Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--connect-ui") { UseShellExecute = true });
                    reply["ok"] = true;
                }
                else
                {
                    reply["ok"] = false;
                    reply["reason"] = "UNKNOWN_REQUEST";
                }
            }
            catch (HelperException e)
            {
                reply["ok"] = false;
                reply["reason"] = e.Code;
                reply["message"] = e.Message;
            }
            catch (Exception e)
            {
                Program.Log("Native messaging error: " + e);
                reply["ok"] = false;
                reply["reason"] = "ERROR";
                reply["message"] = "The AgentShield app had a problem. Reinstall it if this keeps happening.";
            }
            Write(stdout, reply);
            return 0;
        }

        private static Dictionary<string, object> Read(Stream input)
        {
            byte[] len = ReadExactly(input, 4);
            if (len == null) return null;
            int size = BitConverter.ToInt32(len, 0);
            if (size <= 0 || size > 64 * 1024) return null;
            byte[] body = ReadExactly(input, size);
            if (body == null) return null;
            try { return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body)); }
            catch { return null; }
        }

        private static byte[] ReadExactly(Stream s, int count)
        {
            byte[] buf = new byte[count];
            int read = 0;
            while (read < count)
            {
                int n = s.Read(buf, read, count - read);
                if (n <= 0) return null;
                read += n;
            }
            return buf;
        }

        private static void Write(Stream output, Dictionary<string, object> message)
        {
            byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(message));
            output.Write(BitConverter.GetBytes(body.Length), 0, 4);
            output.Write(body, 0, body.Length);
            output.Flush();
        }
    }

    /// <summary>The "Connect AgentShield" window: paste a code (or confirm one from the portal link).</summary>
    internal sealed class ConnectForm : Form
    {
        private readonly Label title = new Label();
        private readonly Label info = new Label();
        private readonly TextBox codeBox = new TextBox();
        private readonly Button connectButton = new Button();
        private readonly Button secondaryButton = new Button();
        private readonly LinkLabel portalLink = new LinkLabel();
        private readonly string presetCode;

        public ConnectForm(string presetCode)
        {
            this.presetCode = presetCode;
            Text = "Connect AgentShield";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 300);
            Font = new Font("Segoe UI", 9.5f);
            BackColor = Color.White;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            title.Font = new Font("Segoe UI Semibold", 14f);
            title.ForeColor = Color.FromArgb(15, 23, 42);
            title.SetBounds(24, 20, 472, 32);

            info.ForeColor = Color.FromArgb(71, 85, 105);
            info.SetBounds(24, 58, 472, 84);

            codeBox.SetBounds(24, 148, 472, 28);
            codeBox.Font = new Font("Consolas", 10f);

            portalLink.SetBounds(24, 184, 472, 22);
            portalLink.LinkClicked += delegate
            {
                string url = Program.PortalUrl();
                if (url != "") Program.OpenUrl(url);
                else MessageBox.Show(this, "Open your AgentShield portal, sign in and go to Connect browser.", "AgentShield");
            };

            connectButton.SetBounds(292, 244, 204, 36);
            connectButton.BackColor = Color.FromArgb(37, 99, 235);
            connectButton.ForeColor = Color.White;
            connectButton.FlatStyle = FlatStyle.Flat;
            connectButton.FlatAppearance.BorderSize = 0;
            connectButton.Font = new Font("Segoe UI Semibold", 10f);
            connectButton.Click += delegate { DoConnect(); };

            secondaryButton.SetBounds(180, 244, 104, 36);
            secondaryButton.FlatStyle = FlatStyle.System;
            secondaryButton.Click += delegate { OnSecondary(); };

            Controls.AddRange(new Control[] { title, info, codeBox, portalLink, connectButton, secondaryButton });
            AcceptButton = connectButton;
            Render();
        }

        private void Render()
        {
            Connection c = Program.LoadConnection();
            if (presetCode != null)
            {
                string apiUrl, token;
                Program.TryParseCode(presetCode, out apiUrl, out token);
                title.Text = "Connect this PC to AgentShield?";
                info.Text = "Your AgentShield portal asked to connect this PC" + (c != null ? " (it replaces the current connection to " + c.Email + ")" : "") +
                            ".\r\n\r\nServer: " + apiUrl + "\r\n\r\nOnly continue if you just clicked \"Connect this PC\" in your own portal.";
                codeBox.Visible = false;
                portalLink.Visible = false;
                connectButton.Text = "Connect";
                secondaryButton.Text = "Cancel";
                return;
            }
            if (c != null)
            {
                title.Text = "This PC is connected";
                info.Text = "Account: " + c.Email + (c.OrganizationName != "" && c.OrganizationName != c.Email ? " (" + c.OrganizationName + ")" : "") +
                            "\r\n\r\nChrome, Edge and Brave on this PC connect by themselves. If a browser still shows \"Activation required\", " +
                            "click its AgentShield icon.\r\n\r\nTo use another account, paste a new code below.";
                connectButton.Text = "Connect with new code";
                secondaryButton.Text = "Disconnect";
            }
            else
            {
                title.Text = "Connect this PC to your account";
                info.Text = "Sign in to the AgentShield portal, open Connect browser and click \"Connect this PC\" " +
                            "(or \"Generate activation code\" and paste the code here).\r\n\r\nYou do this once: every browser on this PC then connects by itself.";
                connectButton.Text = "Connect";
                secondaryButton.Text = "Close";
            }
            codeBox.Visible = true;
            portalLink.Visible = true;
            portalLink.Text = Program.PortalUrl() != "" ? "Open the AgentShield portal to get my code" : "";
        }

        private void OnSecondary()
        {
            if (presetCode == null && Program.LoadConnection() != null && secondaryButton.Text == "Disconnect")
            {
                if (MessageBox.Show(this, "Disconnect this PC? AI sites are blocked in its browsers until it is connected again.",
                        "AgentShield", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                Cursor = Cursors.WaitCursor;
                Program.Disconnect(true);
                Cursor = Cursors.Default;
                Render();
                return;
            }
            Close();
        }

        private void DoConnect()
        {
            string code = presetCode ?? codeBox.Text;
            if (presetCode == null && code.Trim() == "")
            {
                MessageBox.Show(this, "Paste the activation code from the AgentShield portal first.", "AgentShield");
                return;
            }
            connectButton.Enabled = false;
            Cursor = Cursors.WaitCursor;
            try
            {
                Connection c = Program.Connect(code);
                Cursor = Cursors.Default;
                MessageBox.Show(this,
                    "Connected to " + c.Email + ".\r\n\r\nChrome, Edge and Brave on this PC connect by themselves within a minute. " +
                    "To connect a browser right away, click its AgentShield icon.",
                    "AgentShield", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (HelperException e)
            {
                Cursor = Cursors.Default;
                MessageBox.Show(this, e.Message, "AgentShield could not connect", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                connectButton.Enabled = true;
            }
            catch (Exception e)
            {
                Cursor = Cursors.Default;
                Program.Log("Connect failed: " + e);
                MessageBox.Show(this, "Something went wrong: " + e.Message, "AgentShield could not connect", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                connectButton.Enabled = true;
            }
        }
    }
}
