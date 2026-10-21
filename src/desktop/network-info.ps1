# Read current connection metadata only. Does not scan, connect, change settings or read keys.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class LiveScreenWirelessResult {
  public string Ssid;
  public string Status;
  public LiveScreenWirelessResult(string ssid, string status) { Ssid=ssid; Status=status; }
}
public static class LiveScreenWireless {
  [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint current, out IntPtr handle);
  [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
  [DllImport("wlanapi.dll")] static extern uint WlanQueryInterface(IntPtr handle, ref Guid id, uint opcode, IntPtr reserved, out uint size, out IntPtr data, out uint valueType);
  [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr data);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct ConnectionPrefix {
    public uint State;
    public uint Mode;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Profile;
    public uint SsidLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=32)] public byte[] Ssid;
  }
  public static LiveScreenWirelessResult Read(string interfaceId) {
    IntPtr handle=IntPtr.Zero, data=IntPtr.Zero; uint version, size, valueType;
    try {
      uint code=WlanOpenHandle(2,IntPtr.Zero,out version,out handle);
      if(code!=0) return new LiveScreenWirelessResult(null,code==5?"denied":"unavailable");
      Guid id=new Guid(interfaceId);
      code=WlanQueryInterface(handle,ref id,7,IntPtr.Zero,out size,out data,out valueType);
      if(code!=0) return new LiveScreenWirelessResult(null,code==5?"denied":"unavailable");
      if(size<(uint)Marshal.SizeOf(typeof(ConnectionPrefix))) return new LiveScreenWirelessResult(null,"unavailable");
      ConnectionPrefix current=(ConnectionPrefix)Marshal.PtrToStructure(data,typeof(ConnectionPrefix));
      if(current.State!=1 || current.SsidLength==0 || current.SsidLength>32) return new LiveScreenWirelessResult(null,"unavailable");
      string ssid=new UTF8Encoding(false,true).GetString(current.Ssid,0,(int)current.SsidLength);
      return new LiveScreenWirelessResult(ssid,"ok");
    } catch { return new LiveScreenWirelessResult(null,"unavailable"); }
    finally { if(data!=IntPtr.Zero) WlanFreeMemory(data); if(handle!=IntPtr.Zero) WlanCloseHandle(handle,IntPtr.Zero); }
  }
}
'@
$wirelessAvailable = $false
try { Add-Type -TypeDefinition $source; $wirelessAvailable = $true } catch { }
$items = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object {
  $adapter = $_
  if ($adapter.OperationalStatus -eq 'Up') {
    $kind = switch ($adapter.NetworkInterfaceType.ToString()) {
      'Wireless80211' { 'wifi' }
      'Ethernet' { 'ethernet' }
      'GigabitEthernet' { 'ethernet' }
      'FastEthernetFx' { 'ethernet' }
      'FastEthernetT' { 'ethernet' }
      default { 'other' }
    }
    $ssid = $null; $status = 'unavailable'
    if ($kind -eq 'wifi' -and $wirelessAvailable) {
      $result = [LiveScreenWireless]::Read($adapter.Id); $ssid = $result.Ssid; $status = $result.Status
    }
    $addresses = @($adapter.GetIPProperties().UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.Address.ToString() })
    [PSCustomObject]@{ name=$adapter.Name; kind=$kind; ssid=$ssid; ssidStatus=$status; addresses=$addresses }
  }
})
ConvertTo-Json -InputObject $items -Compress -Depth 4
