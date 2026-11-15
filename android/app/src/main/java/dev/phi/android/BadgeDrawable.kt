package dev.phi.android

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import kotlin.math.min

/** Server badge: obsidian disc, server-color ring, Greek letter. */
class BadgeDrawable(
    private val letter: String,
    private val color: Int,
) : Drawable() {
    private val ring =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            this.color = color
        }
    private val fill =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            this.color = Color.parseColor("#141418")
        }
    private val text =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER
            this.color = color
        }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val cx = b.exactCenterX()
        val cy = b.exactCenterY()
        val r = min(b.width(), b.height()) / 2f
        canvas.drawCircle(cx, cy, r - 1f, fill)
        ring.strokeWidth = (r * 0.12f).coerceAtLeast(2f)
        canvas.drawCircle(cx, cy, r - ring.strokeWidth / 2f - 1f, ring)
        text.textSize = r * 0.95f
        val y = cy - (text.descent() + text.ascent()) / 2f
        canvas.drawText(letter, cx, y, text)
    }

    override fun setAlpha(alpha: Int) {
        ring.alpha = alpha
        fill.alpha = alpha
        text.alpha = alpha
    }

    override fun setColorFilter(filter: ColorFilter?) {
        ring.colorFilter = filter
        fill.colorFilter = filter
        text.colorFilter = filter
    }

    @Deprecated("deprecated")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
