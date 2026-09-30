" Phi Ember Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_ember"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#ff7733 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#ff7733
hi IncSearch        guifg=#14141a guibg=#ff4500
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#ff7733 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#ff7733 guibg=#1f1f26  gui=bold
hi Directory        guifg=#ff4500

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#ff7733
hi String           guifg=#ffaa80
hi Character        guifg=#ffaa80
hi Number           guifg=#ff7733
hi Boolean          guifg=#ff7733
hi Float            guifg=#ff7733

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#ff4500

hi Statement        guifg=#ff7733 gui=bold
hi Conditional      guifg=#ff7733 gui=bold
hi Repeat           guifg=#ff7733 gui=bold
hi Label            guifg=#ff7733
hi Operator         guifg=#ff4500
hi Keyword          guifg=#ff7733 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#cc2200
hi Include          guifg=#cc2200
hi Define           guifg=#cc2200
hi Macro            guifg=#cc2200
hi PreCondit        guifg=#cc2200

hi Type             guifg=#cc2200 gui=bold
hi StorageClass     guifg=#cc2200
hi Structure        guifg=#cc2200
hi Typedef          guifg=#cc2200

hi Special          guifg=#ff7733
hi SpecialChar      guifg=#ffaa80
hi Tag              guifg=#ff4500
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#ff4500    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#ff7733  guibg=#1f1f26  gui=bold
