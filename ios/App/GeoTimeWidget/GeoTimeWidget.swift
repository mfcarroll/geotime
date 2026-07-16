import WidgetKit
import SwiftUI
import UIKit

extension Color {
    static let widgetBackground = Color(red: 31 / 255, green: 41 / 255, blue: 55 / 255)   // #1f2937
    static let widgetSecondary  = Color(red: 156 / 255, green: 163 / 255, blue: 175 / 255) // #9ca3af
    static let widgetAccent     = Color(red: 74 / 255, green: 222 / 255, blue: 128 / 255)  // #4ade80 (green pin)
}

struct GeoTimeWidget: Widget {
    let kind = "GeoTimeWorldClocks"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            GeoTimeWidgetView(entry: entry)
        }
        .configurationDisplayName("World Clocks")
        .description("Your world clocks at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct RowMetrics {
    let cityFont: CGFloat
    let timeFont: CGFloat
    let detailFont: CGFloat    // one consistent size for day label / AM-PM
    let subtitleFont: CGFloat  // offset under the city in rich (two-line) mode
    let pinSize: CGFloat
    let rich: Bool             // two-line row (offset under the city name)
    let inlineOffset: Bool     // offset inline after the city (compact medium/large)
    let useFullDay: Bool       // full weekday name ("Tuesday") vs short ("Tue")
    let showLocalLabel: Bool   // "Local time" tag on the local row (single-line only)
    let showDeviceLabel: Bool  // "· Device time" tag on the device row (single-line only)
    let dayUnderTime: Bool     // small two-line: day label under the time, not beside it
    let dayTimeGap: CGFloat    // extra space between day label and time
    let hGap: CGFloat          // base horizontal gap between elements (tighter on small)
    let timeColW: CGFloat
    let periodColW: CGFloat
}

struct GeoTimeWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ClockEntry

    private let richStride: CGFloat = 44
    private let compactStride: CGFloat = 22
    private let footerStride: CGFloat = 16
    private var isSmall: Bool { family == .systemSmall }
    private var detailFont: CGFloat { isSmall ? 7 : 10 }   // smaller secondary text on small
    private var vPad: CGFloat { family == .systemLarge ? 14 : 0 }
    private var hPad: CGFloat { isSmall ? 0 : 12 }
    private var pinSize: CGFloat { isSmall ? 9 : 10 }

    private func width(_ s: String, _ size: CGFloat, weight: UIFont.Weight = .regular, mono: Bool = false) -> CGFloat {
        let font = mono ? UIFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
                        : UIFont.systemFont(ofSize: size, weight: weight)
        return (s as NSString).size(withAttributes: [.font: font]).width
    }

    var body: some View {
        GeometryReader { geo in
            let rows = entry.rows
            let usableH = geo.size.height - vPad * 2

            // Two-line rows (offset under the city) when they all fit — for small
            // and large. Medium keeps its inline-offset single-line look.
            let twoLineFits = Double(rows.count) * richStride <= usableH
            let rich = family != .systemMedium && twoLineFits

            let rowStride = rich ? richStride : compactStride
            let maxRows = max(1, Int(usableH / rowStride))
            let fitCount = rows.count > maxRows
                ? max(1, Int((usableH - footerStride) / rowStride))
                : maxRows
            let result = ZoneRowResolver.fit(rows, maxRows: fitCount)
            let metrics = self.metrics(for: result.visible, usableW: geo.size.width - hPad * 2, rich: rich)

            ZStack(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: rich ? 8 : 4) {
                    ForEach(result.visible) { row in
                        RowView(row: row, metrics: metrics)
                    }
                }
                // Vertically center the rows (looks natural with just a few); when
                // overflowing, top-align so the "+N more" doesn't collide.
                .frame(maxWidth: .infinity, maxHeight: .infinity,
                       alignment: result.overflow > 0 ? .topLeading : .leading)

                if result.overflow > 0 {
                    Text("+\(result.overflow) more")
                        .font(.system(size: detailFont))
                        .foregroundColor(.widgetSecondary)
                }
            }
            .padding(.horizontal, hPad)
            .padding(.vertical, vPad)
        }
        .widgetContainerBackground(Color.widgetBackground)
    }

    // Fixed right-hand columns + one city font size that fits every row's name
    // (plus its inline offset, where shown).
    private func metrics(for rows: [WidgetRow], usableW: CGFloat, rich: Bool) -> RowMetrics {
        let timeFont: CGFloat = (rich && !isSmall) ? 17 : 14
        let inlineOffset = !isSmall && !rich
        let hasPeriod = rows.contains { !$0.timePeriod.isEmpty }
        let periodColW = hasPeriod ? width("PM", detailFont, weight: .medium, mono: true) + 2 : 0
        let timeColW = width("88:88", timeFont, mono: true) + (hasPeriod ? periodColW + 2 : 0)
        let subtitleFont: CGFloat = isSmall ? 9 : 10   // ←— RICH OFFSET-UNDER-CITY SIZE LEVER

        // Max city font. Small has its own value (stays compact even when it
        // expands to two lines, so single-line names still fit); large rich a
        // little larger.  ←— SMALL CITY SIZE LEVER
        let cityBase: CGFloat = isSmall ? 14 : (rich ? 15 : 14)
        let dayTimeGap: CGFloat = isSmall ? 4 : 6   // ←— DAY↔TIME GAP LEVER
        let hGap: CGFloat = isSmall ? 3 : 5
        // Small two-line: the day label tucks under the time (line 2) rather than
        // beside it, so it no longer competes with the city name for line-1 width.
        let dayUnderTime = isSmall && rich

        // City width is limited only by each row's OWN right-side content, so a
        // long name on a row with no day label can use the space that only other
        // rows' day labels occupy. The uniform font is the largest that fits all.
        // Computed twice (short vs full day names): full names are used only when
        // they don't shrink the city — city size wins the trade-off.
        let clusterW = usableW - timeColW - (hGap * 2 + 4)
        func cityScale(fullDay: Bool, localLabel: Bool, deviceLabel: Bool) -> CGFloat {
            var scale: CGFloat = 1
            for r in rows {
                var reserved: CGFloat = 0
                // The marker (pin/phone) sits on line 1 in every layout.
                if r.isLocal || r.isDevice { reserved += pinSize + hGap }
                // Offset + optional labels are on line 1 only in single-line rows;
                // in rich rows they live on line 2 (free of the city's width).
                if !rich {
                    if r.isLocal {
                        if localLabel { reserved += width("Local time", detailFont) + hGap }
                    } else if inlineOffset {
                        reserved += width(r.relativeText, detailFont) + hGap
                        if r.isDevice && deviceLabel { reserved += width("· Device time", detailFont) + hGap }
                    }
                }
                // When the day tucks under the time it doesn't take line-1 width.
                if !dayUnderTime, let day = fullDay ? r.weekdayFull : r.weekdayShort {
                    reserved += width(day, detailFont) + dayTimeGap
                }
                let availName = clusterW - reserved
                let nameW = width(r.name, cityBase)
                if nameW > 0 { scale = min(scale, availName / nameW) }
            }
            return scale
        }
        // Optional labels (full day names, "Local time" / "Device time") are added
        // only when they don't shrink the city — city size wins the trade-off.
        let clampedBase = min(1, cityScale(fullDay: false, localLabel: false, deviceLabel: false))
        let useFullDay = min(1, cityScale(fullDay: true, localLabel: false, deviceLabel: false)) >= clampedBase - 0.001
        let showLocalLabel = !rich && min(1, cityScale(fullDay: false, localLabel: true, deviceLabel: false)) >= clampedBase - 0.001
        // In rich, the label lives on line 2: fine on large, too narrow on small.
        let showDeviceLabel = rich
            ? !isSmall
            : min(1, cityScale(fullDay: false, localLabel: false, deviceLabel: true)) >= clampedBase - 0.001
        let cityFont = max(9, min(cityBase, cityBase * clampedBase))

        return RowMetrics(cityFont: cityFont, timeFont: timeFont, detailFont: detailFont,
                          subtitleFont: subtitleFont, pinSize: pinSize, rich: rich,
                          inlineOffset: inlineOffset, useFullDay: useFullDay,
                          showLocalLabel: showLocalLabel, showDeviceLabel: showDeviceLabel,
                          dayUnderTime: dayUnderTime, dayTimeGap: dayTimeGap, hGap: hGap,
                          timeColW: timeColW, periodColW: periodColW)
    }
}

private struct RowView: View {
    let row: WidgetRow
    let metrics: RowMetrics

    var body: some View {
        if metrics.rich && metrics.dayUnderTime {
            // Small two-line: two independent full-width rows, so the full-word day
            // on line 2 never competes with the city name on line 1.
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                    cityLine
                    Spacer(minLength: 4)
                    time
                }
                HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                    subtitle
                    if let weekday = row.weekdayFull {
                        Spacer(minLength: 4)
                        Text(weekday)
                            .font(.system(size: metrics.detailFont))
                            .foregroundColor(.widgetSecondary)
                            .lineLimit(1)
                    }
                }
            }
        } else if metrics.rich {
            // Large two-line: city/offset on the left; day · time on the right,
            // both blocks aligned on the city/time baseline.
            HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
                VStack(alignment: .leading, spacing: 1) {
                    cityLine
                    subtitle
                }
                Spacer(minLength: 4)
                rightGroup
            }
        } else {
            // Single line: everything sits on one shared baseline.
            HStack(alignment: .lastTextBaseline, spacing: metrics.hGap) {
                cityLine
                Spacer(minLength: 4)
                rightGroup
            }
        }
    }

    // Offset (+ "· Device time" where it fits) shown under the city in rich rows.
    private var subtitle: some View {
        HStack(spacing: 4) {
            Text(row.relativeText)
                .font(.system(size: metrics.subtitleFont))
                .foregroundColor(.widgetSecondary)
                .lineLimit(1)
            if row.isDevice && metrics.showDeviceLabel {
                Text("· Device time")
                    .font(.system(size: metrics.subtitleFont))
                    .foregroundColor(.widgetSecondary)
                    .lineLimit(1)
            }
        }
    }

    // Day · time · AM-PM, sharing a baseline so they read as one line.
    private var rightGroup: some View {
        HStack(alignment: .lastTextBaseline, spacing: 0) {
            if let weekday = metrics.useFullDay ? row.weekdayFull : row.weekdayShort {
                Text(weekday)
                    .font(.system(size: metrics.detailFont))
                    .foregroundColor(.widgetSecondary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.trailing, metrics.dayTimeGap)
            }
            time
        }
    }

    // City name, then either the location pin (local row) or the inline offset
    // ("Vancouver −8 hrs"). The offset reads as a lighter span on the name.
    private var cityLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: metrics.hGap) {
            Text(row.name)
                .font(.system(size: metrics.cityFont, weight: metrics.rich ? .medium : .regular))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.85)   // backstop against measurement rounding
            if metrics.rich {
                // Two-line: marker sits on line 1 after the city; labels on line 2.
                if row.isLocal { pin } else if row.isDevice { phone }
            } else {
                // Single-line: city – offset/label(s) – marker (at the end).
                if row.isLocal {
                    if metrics.showLocalLabel { detailText("Local time") }
                } else if metrics.inlineOffset {
                    detailText(row.relativeText)
                    if row.isDevice && metrics.showDeviceLabel { detailText("· Device time") }
                }
                if row.isLocal { pin } else if row.isDevice { phone }
            }
        }
    }

    private func detailText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: metrics.detailFont))
            .foregroundColor(.widgetSecondary)
            .lineLimit(1)
            .fixedSize()
    }

    // Time cluster: tabular digits + a fixed-width AM/PM column, sharing a
    // baseline. No outer fixed width — the cluster right-aligns at the row's
    // trailing edge, so colons still line up across rows and the day label
    // (when present) hugs the time instead of sitting in a separate column.
    private var time: some View {
        HStack(alignment: .lastTextBaseline, spacing: 1) {
            Text(row.timeDigits)
                .font(.system(size: metrics.timeFont).monospacedDigit())
                .foregroundColor(.white)
                .lineLimit(1)
            if !row.timePeriod.isEmpty {
                Text(row.timePeriod)
                    .font(.system(size: metrics.detailFont, weight: .medium).monospacedDigit())
                    .foregroundColor(.widgetSecondary)
                    .frame(width: metrics.periodColW, alignment: .trailing)
            }
        }
        .fixedSize()   // never wrap the time; the city yields space instead
    }

    @ViewBuilder private var pin: some View {
        Image(systemName: "location.fill")
            .font(.system(size: metrics.pinSize))
            .foregroundColor(.widgetAccent)
    }

    // Phone emoji marking the device's own timezone.
    @ViewBuilder private var phone: some View {
        Text("📱").font(.system(size: metrics.pinSize))
    }
}

extension View {
    @ViewBuilder
    func widgetContainerBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(color, for: .widget)
        } else {
            self.background(color)
        }
    }
}
