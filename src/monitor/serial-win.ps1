# Embedded Studio seri port yardımcısı (Windows, ES-211). Yerel Node modülü gerektirmez: .NET System.IO.Ports.
#
# Protokol (satır tabanlı, ASCII):
#   stdout:  O                    port açıldı
#            D <base64>           gelen veri
#            E <metin>            hata (ardından çıkılır)
#   stdin:   W <base64>           gönder
#            S <dtr 0|1> <rts 0|1> modem sinyalleri
#            B <ms>               break gönder
#            Q                    kapat
param(
  [string]$Port, [int]$Baud = 115200, [int]$DataBits = 8, [string]$Parity = 'None', [string]$StopBits = 'One',
  [string]$Flow = 'none', [int]$Dtr = 1, [int]$Rts = 1, [switch]$List
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if ($List) {
  # Etkin portlar ve aygıt adları (USB VCP'lerde "STMicroelectronics STLink Virtual COM Port (COM5)")
  $names = @{}
  try {
    Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%(COM%'" | ForEach-Object {
      if ($_.Name -match '\((COM\d+)\)') { $names[$Matches[1]] = @{ name = $_.Name; id = $_.PNPDeviceID } }
    }
  } catch { }
  $out = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique | ForEach-Object {
    $n = $names[$_]
    @{ path = $_; name = if ($n) { $n.name } else { $_ }; id = if ($n) { $n.id } else { '' } }
  })
  ConvertTo-Json -InputObject $out -Compress
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Ports;
using System.Text;
using System.Threading;

public static class EsSerial {
  static readonly object Gate = new object();
  static Stream Out;
  static void Emit(string s) {
    var b = Encoding.UTF8.GetBytes(s + "\n");
    lock (Gate) { Out.Write(b, 0, b.Length); Out.Flush(); }
  }
  public static int Run(string name, int baud, int dataBits, string parity, string stopBits, string flow, bool dtr, bool rts) {
    Out = Console.OpenStandardOutput();
    SerialPort p;
    try {
      p = new SerialPort(name, baud, (Parity)Enum.Parse(typeof(Parity), parity), dataBits, (StopBits)Enum.Parse(typeof(StopBits), stopBits));
      p.Handshake = flow == "rtscts" ? Handshake.RequestToSend : flow == "xonxoff" ? Handshake.XOnXOff : Handshake.None;
      p.ReadTimeout = 50;
      p.WriteTimeout = 2000;
      p.ReadBufferSize = 1 << 16;
      p.DtrEnable = dtr;
      if (p.Handshake != Handshake.RequestToSend) p.RtsEnable = rts;
      p.Open();
    } catch (Exception e) {
      Emit("E " + e.GetType().Name + ": " + e.Message.Replace("\r", " ").Replace("\n", " "));
      return 2;
    }
    Emit("O");
    var reader = new Thread(() => {
      var buf = new byte[8192];
      while (true) {
        int n;
        try { n = p.Read(buf, 0, buf.Length); }
        catch (TimeoutException) { continue; }
        catch (Exception e) {
          if (p.IsOpen) Emit("E " + e.GetType().Name + ": " + e.Message.Replace("\r", " ").Replace("\n", " "));
          Environment.Exit(3);
          return;
        }
        if (n > 0) Emit("D " + Convert.ToBase64String(buf, 0, n));
      }
    });
    reader.IsBackground = true;
    reader.Start();
    var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string line;
    while ((line = input.ReadLine()) != null) {
      try {
        if (line.StartsWith("W ")) { var b = Convert.FromBase64String(line.Substring(2)); p.Write(b, 0, b.Length); }
        else if (line.StartsWith("S ")) {
          var a = line.Split(' ');
          p.DtrEnable = a[1] == "1";
          if (p.Handshake != Handshake.RequestToSend) p.RtsEnable = a[2] == "1";
        }
        else if (line.StartsWith("B ")) { p.BreakState = true; Thread.Sleep(int.Parse(line.Substring(2))); p.BreakState = false; }
        else if (line == "Q") break;
      } catch (Exception e) {
        Emit("E " + e.GetType().Name + ": " + e.Message.Replace("\r", " ").Replace("\n", " "));
      }
    }
    try { p.Close(); } catch (Exception) { }
    return 0;
  }
}
'@
exit [EsSerial]::Run($Port, $Baud, $DataBits, $Parity, $StopBits, $Flow, $Dtr -ne 0, $Rts -ne 0)
