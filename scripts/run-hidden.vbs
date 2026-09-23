' run-hidden.vbs - run a command line with no console window (used by the Baton autostart task).
Dim sh, i, a, cmd
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = Chr(34) & a & Chr(34)
  cmd = cmd & a & " "
Next
sh.Run Trim(cmd), 0, False
