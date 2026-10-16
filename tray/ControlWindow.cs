using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Devhub
{
    /// <summary>The tray's small, persistent control surface. All service actions belong to TrayApp.</summary>
    internal sealed class ControlWindow : Form
    {
        private static readonly Color Surface = Color.FromArgb(24, 27, 33);
        private static readonly Color Raised = Color.FromArgb(36, 41, 50);
        private static readonly Color TextColor = Color.FromArgb(235, 240, 247);
        private static readonly Color Muted = Color.FromArgb(154, 165, 181);
        private static readonly Color Accent = Color.FromArgb(89, 202, 170);
        private static readonly Color Warning = Color.FromArgb(238, 184, 107);
        private readonly QueueView queueView;
        private readonly Label hubStatus;
        private readonly Label queueState;
        private readonly Label errorLabel;
        private readonly Label footnote;
        private readonly TableLayoutPanel layout;
        private readonly Button start;
        private readonly Button restart;
        private readonly Button stopHub;
        private readonly Button web;
        private readonly Button logs;
        private readonly Button refresh;
        private readonly Button pause;
        private readonly Button stop;
        private readonly Button resume;
        private readonly ToolTip hints;
        private readonly Font titleFont;
        private readonly Font smallFont;
        private bool disposing;

        private sealed class ControlButton : Button
        {
            protected override void OnPaint(PaintEventArgs args)
            {
                if (Enabled)
                {
                    base.OnPaint(args);
                    return;
                }
                args.Graphics.Clear(Color.FromArgb(29, 33, 40));
                ControlPaint.DrawBorder(args.Graphics, ClientRectangle,
                    Color.FromArgb(48, 55, 66), ButtonBorderStyle.Solid);
                Rectangle textBounds = ClientRectangle;
                textBounds.Inflate(-4, -1);
                TextRenderer.DrawText(args.Graphics, Text, Font, textBounds, Muted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            }
        }

        public event Action StartRequested;
        public event Action RestartRequested;
        public event Action StopRequested;
        public event Action OpenWebRequested;
        public event Action LogsRequested;
        public event Action RefreshRequested;
        public event Action<string> QueueCommandRequested;

        /// <summary>Only a person clicking the confirmation may stop the owner's queue.</summary>
        internal Func<bool> StopConfirmation { get; set; }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        public ControlWindow()
        {
            Text = "Пульт · DevHub и Inference";
            Name = "control-window";
            FormBorderStyle = FormBorderStyle.Sizable;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(440, 566);
            MinimumSize = new Size(400, 500);
            BackColor = Surface;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9F);
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            DoubleBuffered = true;
            MaximizeBox = false;
            titleFont = new Font("Segoe UI", 12F, FontStyle.Bold);
            smallFont = new Font("Segoe UI", 8F);
            hints = new ToolTip();

            layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(16, 12, 16, 10);
            layout.BackColor = Surface;
            layout.ColumnCount = 1;
            layout.RowCount = 9;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 27));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 31));
            Controls.Add(layout);

            var hubHeading = new TableLayoutPanel();
            hubHeading.Dock = DockStyle.Fill;
            hubHeading.Margin = Padding.Empty;
            hubHeading.ColumnCount = 2;
            hubHeading.RowCount = 1;
            hubHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            hubHeading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115));
            hubHeading.Controls.Add(Label("DevHub", titleFont, TextColor), 0, 0);
            web = Button("web", "Веб-панель ↗", delegate { Raise(OpenWebRequested); });
            hubHeading.Controls.Add(web, 1, 0);
            layout.Controls.Add(hubHeading, 0, 0);

            hubStatus = Label("Проверяю пульт…", Font, Muted);
            layout.Controls.Add(hubStatus, 0, 1);
            start = Button("start", "Запустить", delegate { Raise(StartRequested); });
            restart = Button("restart", "Перезапустить", delegate { Raise(RestartRequested); });
            stopHub = Button("stop", "Остановить", delegate { Raise(StopRequested); });
            logs = Button("logs", "Логи", delegate { Raise(LogsRequested); });
            var hubPrimary = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
            hubPrimary.Controls.Add(start);
            hubPrimary.Controls.Add(restart);
            layout.Controls.Add(ButtonRow(hubPrimary, stopHub, logs), 0, 2);
            hints.SetToolTip(restart, "Перезапустить только DevHub. Inference и задания продолжат работу.");
            hints.SetToolTip(stopHub, "Выключить только DevHub. Inference и серверы проектов продолжат работу.");
            hints.SetToolTip(logs, "Открыть папку с логами DevHub");

            var divider = new Panel();
            divider.BackColor = Color.FromArgb(48, 55, 66);
            divider.Dock = DockStyle.Fill;
            divider.Margin = new Padding(0, 11, 0, 10);
            layout.Controls.Add(divider, 0, 3);

            var inferenceHeading = new TableLayoutPanel();
            inferenceHeading.Dock = DockStyle.Fill;
            inferenceHeading.Margin = Padding.Empty;
            inferenceHeading.ColumnCount = 1;
            inferenceHeading.RowCount = 2;
            inferenceHeading.RowStyles.Add(new RowStyle(SizeType.Absolute, 25));
            inferenceHeading.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            inferenceHeading.Controls.Add(Label("Inference", titleFont, TextColor), 0, 0);
            queueState = Label("Проверяю очередь…", smallFont, Muted);
            inferenceHeading.Controls.Add(queueState, 0, 1);
            layout.Controls.Add(inferenceHeading, 0, 4);

            queueView = new QueueView();
            queueView.Name = "queue-view";
            queueView.Dock = DockStyle.Fill;
            queueView.Margin = Padding.Empty;
            layout.Controls.Add(queueView, 0, 5);

            pause = Button("queue-pause", "Пауза", delegate { QueueAction("/api/queue/pause"); });
            stop = Button("queue-stop", "Стоп очереди", delegate
            {
                if (StopConfirmation != null && StopConfirmation()) { QueueAction("/api/queue/stop"); }
            });
            resume = Button("queue-continue", "Продолжить", delegate { QueueAction("/api/queue/continue"); });
            var queueActions = ButtonRow(pause, stop, resume);
            queueActions.Padding = new Padding(0, 10, 0, 0);
            layout.Controls.Add(queueActions, 0, 6);
            hints.SetToolTip(pause, "Временно не начинать новые задания. Текущие продолжат работу.");
            hints.SetToolTip(stop, "Остановить начало новых заданий до вашей команды «Продолжить».");
            hints.SetToolTip(resume, "Продолжить общую очередь после стопа или паузы.");

            errorLabel = Label("", smallFont, Color.FromArgb(244, 150, 150));
            errorLabel.Name = "action-error";
            errorLabel.Padding = new Padding(0, 4, 0, 0);
            errorLabel.AutoEllipsis = true;
            layout.Controls.Add(errorLabel, 0, 7);

            var footer = new TableLayoutPanel();
            footer.Dock = DockStyle.Fill;
            footer.Margin = Padding.Empty;
            footer.Padding = new Padding(0, 6, 0, 0);
            footer.ColumnCount = 2;
            footer.RowCount = 1;
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
            footnote = Label("Обновляется автоматически", smallFont, Muted);
            footer.Controls.Add(footnote, 0, 0);
            refresh = Button("refresh", "Обновить", delegate { Raise(RefreshRequested); });
            refresh.Font = smallFont;
            footer.Controls.Add(refresh, 1, 0);
            layout.Controls.Add(footer, 0, 8);

            StopConfirmation = delegate
            {
                return MessageBox.Show(this,
                    "Новые задания не будут запускаться, пока вы не нажмёте «Продолжить». "
                    + "Выполняющиеся задания продолжат работу.\n\nОстановить общую очередь?",
                    "Стоп общей очереди", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            };
            ApplyState(null, null, null, false, null);
        }

        private static Label Label(string text, Font font, Color color)
        {
            return new Label
            {
                Text = text,
                Font = font,
                ForeColor = color,
                Dock = DockStyle.Fill,
                Margin = Padding.Empty,
                TextAlign = ContentAlignment.MiddleLeft,
                AutoEllipsis = true,
                UseMnemonic = false,
            };
        }

        private Button Button(string name, string text, Action action)
        {
            var button = new ControlButton();
            button.Name = name;
            button.Text = text;
            button.Dock = DockStyle.Fill;
            button.Margin = Padding.Empty;
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = Color.FromArgb(59, 68, 81);
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(47, 55, 66);
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(55, 66, 79);
            button.BackColor = Raised;
            button.ForeColor = TextColor;
            button.UseVisualStyleBackColor = false;
            button.UseMnemonic = false;
            button.Cursor = Cursors.Hand;
            button.Click += delegate { if (button.Enabled) { action(); } };
            return button;
        }

        private static TableLayoutPanel ButtonRow(params Control[] buttons)
        {
            var row = new TableLayoutPanel();
            row.Dock = DockStyle.Fill;
            row.Margin = Padding.Empty;
            row.RowCount = 1;
            row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            row.ColumnCount = buttons.Length * 2 - 1;
            for (int index = 0; index < buttons.Length; index++)
            {
                row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / buttons.Length));
                row.Controls.Add(buttons[index], index * 2, 0);
                if (index + 1 < buttons.Length) { row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 7)); }
            }
            return row;
        }

        private static void Raise(Action action)
        {
            if (action != null) { action(); }
        }

        private void QueueAction(string path)
        {
            var action = QueueCommandRequested;
            if (action != null) { action(path); }
        }

        private static bool Can(QueueMenu menu, string path)
        {
            if (menu == null) { return false; }
            foreach (QueueItem item in menu.Items)
            {
                if (item.Post == path) { return item.Enabled; }
            }
            return false;
        }

        private static string QueueState(QueueMenu queue)
        {
            object value;
            return queue != null && queue.Status != null && queue.Status.TryGetValue("state", out value)
                ? value as string ?? "" : "";
        }

        public void ApplyState(Health health, QueueMenu queue, string hubText, bool pending, string error)
        {
            bool up = health != null && health.Up;
            hubStatus.Text = !string.IsNullOrEmpty(hubText) ? hubText : health == null ? "Проверяю пульт…"
                : up ? "● Пульт работает · сервисов: " + health.Managed : "● Пульт выключен";
            hubStatus.ForeColor = up ? Accent : health == null ? Muted : Warning;
            start.Visible = !up;
            start.Enabled = !pending && health != null && !up;
            restart.Visible = up;
            restart.Enabled = !pending && up;
            stopHub.Enabled = !pending && up;
            web.Enabled = !pending && up;
            logs.Enabled = !pending;
            refresh.Enabled = !pending;
            pause.Enabled = !pending && up && Can(queue, "/api/queue/pause");
            stop.Enabled = !pending && up && Can(queue, "/api/queue/stop");
            resume.Enabled = !pending && up && Can(queue, "/api/queue/continue");
            queueView.UpdateStatus(up && queue != null ? queue.Status : null);

            string state = QueueState(queue);
            queueState.Text = !up ? "Нет связи с пультом" : state == "stopped" ? "Стоп владельца · новые задания ожидают"
                : state == "paused" ? "Пауза · новые задания ожидают"
                : state == "working" ? "Выполняет задания" : state == "ready" ? "Готов к заданиям"
                : state == "offline" ? "Нет связи с Inference" : "Данные очереди недоступны";
            queueState.ForeColor = !up ? Muted : state == "stopped" || state == "paused" ? Warning
                : state == "working" || state == "ready" ? Accent : Muted;
            string message = error ?? "";
            errorLabel.Text = message;
            hints.SetToolTip(errorLabel, message);
            layout.RowStyles[7].Height = message.Length > 0 ? 38 : 0;
            footnote.Text = pending ? "Выполняю команду…" : "Обновляется автоматически";
        }

        public void Open()
        {
            if (IsDisposed) { return; }
            if (!Visible) { Show(); }
            if (WindowState == FormWindowState.Minimized) { WindowState = FormWindowState.Normal; }
            BringToFront();
            Activate();
        }

        protected override void OnHandleCreated(EventArgs args)
        {
            base.OnHandleCreated(args);
            try
            {
                int dark = 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            if (!disposing && args.CloseReason == CloseReason.UserClosing)
            {
                args.Cancel = true;
                Hide();
            }
            base.OnFormClosing(args);
        }

        protected override void Dispose(bool release)
        {
            disposing = true;
            base.Dispose(release);
            if (release)
            {
                hints.Dispose();
                titleFont.Dispose();
                smallFont.Dispose();
            }
        }
    }
}
